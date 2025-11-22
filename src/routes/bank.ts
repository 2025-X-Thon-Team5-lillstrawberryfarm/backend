import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

type ConnectRequestBody = {
  kftcAuthCode?: string;
  scope?: string;
  bankName?: string;
  transactions?: IncomingTransaction[];
};

type KftcTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_seq_no: string;
  refresh_token?: string;
  [key: string]: unknown;
};

const bankRouter = Router();
type UserTokenRow = RowDataPacket & {
  kftc_access_token: string | null;
  kftc_refresh_token: string | null;
  kftc_user_seq_no: string | null;
  kftc_token_expires_at: Date | null;
};

type IncomingTransaction = {
  kftc_tran_id: string;
  transacted_at: string; // ISO string
  original_content?: string;
  amount: number;
  balance_after?: number;
  type: 'DEPOSIT' | 'WITHDRAW';
  method?: string;
  store_name?: string;
  category?: string;
  is_excluded?: boolean;
  memo?: string;
  account_id?: number;
};

const KFTC_BASE_URL = (process.env.KFTC_BASE_URL || 'https://testapi.openbanking.or.kr').replace(/\/+$/, '');
const KFTC_CLIENT_ID = process.env.KFTC_CLIENT_ID;
const KFTC_CLIENT_SECRET = process.env.KFTC_CLIENT_SECRET;
const KFTC_REDIRECT_URI = process.env.KFTC_REDIRECT_URI;

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const stateStore = new Map<string, number>(); // state -> expiresAt

function generateState(): string {
  return crypto.randomBytes(16).toString('hex'); // 32 chars
}

function rememberState(state: string): void {
  stateStore.set(state, Date.now() + STATE_TTL_MS);
}

function validateAndConsumeState(state: string): boolean {
  const expiresAt = stateStore.get(state);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    stateStore.delete(state);
    return false;
  }
  stateStore.delete(state);
  return true;
}

function assertEnv(): void {
  const missing = [];
  if (!KFTC_CLIENT_ID) missing.push('KFTC_CLIENT_ID');
  if (!KFTC_CLIENT_SECRET) missing.push('KFTC_CLIENT_SECRET');
  if (!KFTC_REDIRECT_URI) missing.push('KFTC_REDIRECT_URI');

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

async function exchangeAuthCode(authCode: string, scope: string): Promise<KftcTokenResponse> {
  assertEnv();

  const tokenUrl = `${KFTC_BASE_URL}/oauth/2.0/token`;
  const body = new URLSearchParams({
    code: authCode,
    client_id: KFTC_CLIENT_ID as string,
    client_secret: KFTC_CLIENT_SECRET as string,
    redirect_uri: KFTC_REDIRECT_URI as string,
    grant_type: 'authorization_code',
    scope,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body,
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`KFTC token exchange failed (${response.status}): ${rawBody}`);
  }

  try {
    return JSON.parse(rawBody) as KftcTokenResponse;
  } catch (err) {
    throw new Error(`Failed to parse KFTC response: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

async function refreshAccessToken(refreshToken: string, scope: string, userSeqNo?: string | null): Promise<KftcTokenResponse> {
  assertEnv();

  const tokenUrl = `${KFTC_BASE_URL}/oauth/2.0/token`;
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: KFTC_CLIENT_ID as string,
    client_secret: KFTC_CLIENT_SECRET as string,
    grant_type: 'refresh_token',
    scope,
  });

  if (userSeqNo) {
    body.set('user_seq_no', userSeqNo);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body,
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`KFTC token refresh failed (${response.status}): ${rawBody}`);
  }

  try {
    return JSON.parse(rawBody) as KftcTokenResponse;
  } catch (err) {
    throw new Error(`Failed to parse KFTC refresh response: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

export async function ensureKftcAccessToken(userId: number, requestedScope = 'login transfer'): Promise<string> {
  const [rows] = await pool.execute<UserTokenRow[]>(
    `SELECT kftc_access_token, kftc_refresh_token, kftc_user_seq_no, kftc_token_expires_at
     FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  const userToken = rows[0];

  if (!userToken) {
    throw new Error('user_not_found');
  }

  const { kftc_access_token, kftc_refresh_token, kftc_token_expires_at, kftc_user_seq_no } = userToken;

  const now = Date.now();
  const expiresAt = kftc_token_expires_at ? new Date(kftc_token_expires_at).getTime() : null;
  const bufferMs = 2 * 60 * 1000; // 2 minutes buffer

  const isValid = !!kftc_access_token && !!expiresAt && expiresAt - now > bufferMs;
  if (isValid) return kftc_access_token as string;

  if (!kftc_refresh_token) {
    throw new Error('refresh_token_missing');
  }

  const refreshed = await refreshAccessToken(kftc_refresh_token, requestedScope, kftc_user_seq_no);

  const accessToken = refreshed.access_token ?? null;
  const refreshToken = refreshed.refresh_token ?? kftc_refresh_token ?? null;
  const userSeqNo = refreshed.user_seq_no ?? kftc_user_seq_no ?? null;
  const expiresInRaw = refreshed.expires_in;
  const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : expiresInRaw ? Number(expiresInRaw) : null;

  if (!accessToken) {
    throw new Error('refresh_response_missing_access_token');
  }

  await pool.execute(
    `UPDATE users 
     SET kftc_access_token = ?, 
         kftc_refresh_token = ?, 
         kftc_user_seq_no = ?, 
         kftc_token_expires_at = IFNULL(DATE_ADD(NOW(), INTERVAL ? SECOND), NULL)
     WHERE id = ?`,
    [
      accessToken,
      refreshToken,
      userSeqNo,
      expiresIn ?? 0,
      userId,
    ]
  );

  return accessToken;
}

bankRouter.get('/auth-url', (_req: Request, res: Response) => {
  try {
    assertEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Missing env';
    return res.status(500).json({ error: message });
  }

  const state = generateState();
  rememberState(state);
  const scope = 'login transfer';

  const url = new URL(`${KFTC_BASE_URL}/oauth/2.0/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', KFTC_CLIENT_ID as string);
  url.searchParams.set('redirect_uri', KFTC_REDIRECT_URI as string);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('auth_type', '0');

  return res.json({
    authUrl: url.toString(),
    state,
    scope,
  });
});

bankRouter.get('/auth/callback', (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const scope = (req.query.scope as string | undefined) || 'login transfer';

  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (!state) {
    return res.status(400).json({ error: 'state is required' });
  }
  if (!validateAndConsumeState(state)) {
    return res.status(400).json({ error: 'invalid_or_expired_state' });
  }

  return res.status(200).json({
    kftcAuthCode: code,
    scope,
    state,
  });
});

bankRouter.post('/connect', requireAuth, async (req: Request, res: Response) => {
  const { kftcAuthCode, scope, bankName, transactions }: ConnectRequestBody = req.body || {};

  if (!kftcAuthCode) {
    return res.status(400).json({ error: 'kftcAuthCode is required' });
  }

  const requestedScope = scope || 'login transfer';

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const tokenResponse = await exchangeAuthCode(kftcAuthCode, requestedScope);

    const accessToken = tokenResponse.access_token ?? null;
    const refreshToken = tokenResponse.refresh_token ?? null;
    const userSeqNo = tokenResponse.user_seq_no ?? null;
    const expiresInRaw = tokenResponse.expires_in;
    const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : expiresInRaw ? Number(expiresInRaw) : null;

    if (!accessToken) {
      console.error('[KFTC][connect] missing access_token in response:', tokenResponse);
      return res.status(502).json({
        error: 'invalid_kftc_response',
        detail: process.env.NODE_ENV === 'production' ? undefined : tokenResponse,
      });
    }

    // 사용자 토큰 저장
    await pool.execute(
      `UPDATE users 
       SET kftc_access_token = ?, 
           kftc_refresh_token = ?, 
           kftc_user_seq_no = ?, 
           kftc_token_expires_at = IFNULL(DATE_ADD(NOW(), INTERVAL ? SECOND), NULL)
       WHERE id = ?`,
      [
        accessToken,
        refreshToken,
        userSeqNo,
        expiresIn ?? 0,
        userId,
      ]
    );

    let syncedCount = 0;

    if (transactions && Array.isArray(transactions) && transactions.length > 0) {
      const values = transactions.map((t) => [
        userId,
        t.account_id ?? null,
        t.kftc_tran_id,
        t.transacted_at,
        t.original_content ?? null,
        t.amount,
        t.balance_after ?? null,
        t.type,
        t.method ?? null,
        t.store_name ?? null,
        t.category ?? null,
        t.is_excluded ?? false,
        t.memo ?? null,
      ]);

      const insertSql = `
        INSERT IGNORE INTO transactions
        (user_id, account_id, kftc_tran_id, transacted_at, original_content, amount, balance_after, type, method, store_name, category, is_excluded, memo)
        VALUES ?
      `;

      const [result] = await pool.query<ResultSetHeader>(insertSql, [values]);
      syncedCount = result.affectedRows;
    }

    return res.status(200).json({
      status: 'SYNC_COMPLETED',
      syncedCount,
      bankName: bankName || 'unknown',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    console.error('[KFTC][connect] token exchange failed:', message);
    return res.status(502).json({ error: 'Failed to exchange kftcAuthCode', detail: message });
  }
});

// 유효한 access_token을 반환하는 헬퍼 엔드포인트 (테스트/디버깅용)
bankRouter.get('/access-token', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const token = await ensureKftcAccessToken(userId);
    return res.status(200).json({ accessToken: token });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    return res.status(400).json({ error: 'token_refresh_failed', detail: message });
  }
});

export default bankRouter;
