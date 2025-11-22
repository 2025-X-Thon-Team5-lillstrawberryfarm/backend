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
  fromDate?: string; // YYYYMMDD
  toDate?: string;   // YYYYMMDD
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

type KftcUserInfo = {
  bank_name?: string;
  user_name?: string;
  fintech_use_num?: string;
  fintech_use_nums?: string[]; // 일부 응답에서 계좌 목록을 반환할 수 있음
  [key: string]: unknown;
};

type KftcTransactionRaw = {
  tran_date: string; // YYYYMMDD
  tran_time: string; // HHMMSS
  printed_content?: string;
  tran_amt: number;
  after_balance_amt?: number;
  inout_type: '입금' | '출금' | string;
  tran_id?: string;
};

type KftcAccount = {
  fintech_use_num: string;
  bank_name?: string;
  account_num?: string;
  balance_amt?: number;
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

type FetchAccountRequest = {
  fintechUseNum: string;
  fromDate?: string; // YYYYMMDD
  toDate?: string;   // YYYYMMDD
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

async function fetchKftcUserInfo(accessToken: string): Promise<KftcUserInfo | null> {
  assertEnv();
  const url = `${KFTC_BASE_URL}/v2.0/user/me`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error(`KFTC user info failed (${resp.status}): ${raw}`);
  }

  const raw = await resp.text();
  try {
    return JSON.parse(raw) as KftcUserInfo;
  } catch (err) {
    throw new Error(`Failed to parse KFTC user info: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

async function fetchKftcAccounts(accessToken: string): Promise<KftcAccount[]> {
  assertEnv();
  // 실제 KFTC 계좌 목록 API 엔드포인트는 환경에 맞게 수정 필요
  const url = `${KFTC_BASE_URL}/v2.0/account/list`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`KFTC account list failed (${resp.status}): ${raw}`);
  }

  try {
    const parsed = JSON.parse(raw) as { res_list?: KftcAccount[]; [key: string]: unknown };
    return parsed.res_list ?? [];
  } catch (err) {
    throw new Error(`Failed to parse KFTC account list: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

async function fetchKftcTransactions(
  accessToken: string,
  fintechUseNum: string,
  fromDate?: string,
  toDate?: string
): Promise<KftcTransactionRaw[]> {
  assertEnv();

  const url = new URL(`${KFTC_BASE_URL}/v2.0/account/transaction_list/fin_num`);
  url.searchParams.set('fintech_use_num', fintechUseNum);
  url.searchParams.set('sort_order', 'D'); // Desc
  if (fromDate) url.searchParams.set('from_date', fromDate); // YYYYMMDD
  if (toDate) url.searchParams.set('to_date', toDate); // YYYYMMDD

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`KFTC transactions failed (${resp.status}): ${raw}`);
  }

  try {
    const parsed = JSON.parse(raw) as { res_list?: KftcTransactionRaw[]; [key: string]: unknown };
    return parsed.res_list ?? [];
  } catch (err) {
    throw new Error(`Failed to parse KFTC transactions: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

async function upsertBankAccount(userId: number, acc: KftcAccount): Promise<number | null> {
  const key = acc.account_num || acc.fintech_use_num;
  if (!key) return null;
  const bankName = acc.bank_name ?? 'unknown';
  const balance = acc.balance_amt ?? null;

  const [found] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM bank_accounts WHERE user_id = ? AND account_num = ? LIMIT 1`,
    [userId, key]
  );
  const existing = found[0];
  if (existing?.id) {
    await pool.execute(
      `UPDATE bank_accounts SET bank_name = ?, balance = ? WHERE id = ?`,
      [bankName, balance, existing.id]
    );
    return existing.id as number;
  }

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO bank_accounts (user_id, bank_name, account_num, balance) VALUES (?, ?, ?, ?)`,
    [userId, bankName, key, balance]
  );
  return result.insertId;
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
  const { kftcAuthCode, scope, bankName, transactions, fromDate, toDate }: ConnectRequestBody = req.body || {};

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

    let responseBankName = bankName || 'unknown';
    let responseTransactions: Array<{
      kftc_tran_id: string;
      transacted_at: string;
      store_name: string | null;
      category: string | null;
      amount: number;
    }> = [];

    if (transactions && Array.isArray(transactions) && transactions.length > 0) {
      // 클라이언트가 거래를 직접 보낸 경우 그대로 저장
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

      await pool.query<ResultSetHeader>(insertSql, [values]);
      responseTransactions = values.map((v) => ({
        kftc_tran_id: v[2] as string,
        transacted_at: v[3] as string,
        store_name: v[9] as string | null,
        category: v[10] as string | null,
        amount: v[5] as number,
      }));
    } else {
      // 서버가 금융결제원에서 모든 계좌/거래를 가져와 저장
      const userInfo = await fetchKftcUserInfo(accessToken);
      if (userInfo?.bank_name) responseBankName = userInfo.bank_name;

      const accounts = await fetchKftcAccounts(accessToken);
      const allValues: any[] = [];

      for (const acc of accounts) {
        const accountId = await upsertBankAccount(userId, acc);
        const fintechUseNum = acc.fintech_use_num;
        if (!fintechUseNum) continue;

        const rawList = await fetchKftcTransactions(accessToken, fintechUseNum, fromDate, toDate);
        const mapped = rawList.map((t) => {
          const hh = t.tran_time?.substring(0, 2) || '00';
          const mm = t.tran_time?.substring(2, 4) || '00';
          const ss = t.tran_time?.substring(4, 6) || '00';
          const isoDate = `${t.tran_date}T${hh}:${mm}:${ss}`;
          const kftcTranId = t.tran_id || `${t.tran_date}-${t.tran_time}-${t.printed_content ?? ''}-${t.tran_amt}`;
          const type = t.inout_type === '입금' ? 'DEPOSIT' : 'WITHDRAW';

          return [
            userId,
            accountId ?? null,
            kftcTranId,
            isoDate,
            t.printed_content ?? null,
            t.tran_amt,
            t.after_balance_amt ?? null,
            type,
            null, // method
            t.printed_content ?? null, // store_name
            null, // category (AI 미적용)
            false,
            null, // memo
          ];
        });

        allValues.push(...mapped);
      }

      if (allValues.length > 0) {
        const insertSql = `
          INSERT IGNORE INTO transactions
          (user_id, account_id, kftc_tran_id, transacted_at, original_content, amount, balance_after, type, method, store_name, category, is_excluded, memo)
          VALUES ?
        `;
        await pool.query<ResultSetHeader>(insertSql, [allValues]);

        responseTransactions = allValues.map((v) => ({
          kftc_tran_id: v[2] as string,
          transacted_at: v[3] as string,
          store_name: v[9] as string | null,
          category: v[10] as string | null,
          amount: v[5] as number,
        }));
      }
    }

    return res.status(200).json({
      status: 'SYNC_COMPLETED',
      bankName: responseBankName,
      transactions: responseTransactions,
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

// KFTC 거래내역을 직접 불러와서 DB 저장 후 반환 (Python AI 제외)
bankRouter.post('/account', requireAuth, async (req: Request, res: Response) => {
  const { fintechUseNum, fromDate, toDate }: FetchAccountRequest = req.body || {};
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!fintechUseNum) {
    return res.status(400).json({ error: 'fintechUseNum_required' });
  }

  try {
    // 1) 유효 토큰 확보 (만료 시 자동 리프레시)
    const accessToken = await ensureKftcAccessToken(userId);

    // 2) 사용자/은행 정보 조회
    const userInfo = await fetchKftcUserInfo(accessToken);
    const bankName = userInfo?.bank_name || 'unknown';

    // 3) 금융결제원 거래내역 조회 (Raw)
    const rawList = await fetchKftcTransactions(accessToken, fintechUseNum, fromDate, toDate);

    // 4) 가공 및 DB 저장 (AI 제외, printed_content -> store_name, category=null)
    const values = rawList.map((t) => {
      const isoDate = `${t.tran_date}T${t.tran_time.substring(0, 2)}:${t.tran_time.substring(2, 4)}:${t.tran_time.substring(4, 6)}`;
      const kftcTranId = t.tran_id || `${t.tran_date}-${t.tran_time}-${t.printed_content ?? ''}-${t.tran_amt}`;
      const type = t.inout_type === '입금' ? 'DEPOSIT' : 'WITHDRAW';

      return [
        userId,
        null, // account_id 알 수 없으므로 null
        kftcTranId,
        isoDate,
        t.printed_content ?? null,
        t.tran_amt,
        t.after_balance_amt ?? null,
        type,
        null, // method
        t.printed_content ?? null, // store_name = 원본 적요
        null, // category (AI 미적용)
        false,
        null, // memo
      ];
    });

    if (values.length > 0) {
      const insertSql = `
        INSERT IGNORE INTO transactions
        (user_id, account_id, kftc_tran_id, transacted_at, original_content, amount, balance_after, type, method, store_name, category, is_excluded, memo)
        VALUES ?
      `;
      await pool.query<ResultSetHeader>(insertSql, [values]);
    }

    const responseTransactions = values.map((v) => ({
      kftc_tran_id: v[2],
      transacted_at: v[3],
      store_name: v[9],
      category: v[10],
      amount: v[5],
    }));

    return res.status(200).json({
      status: 'SYNC_COMPLETED',
      bankName,
      transactions: responseTransactions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[KFTC][account] sync failed:', message);
    return res.status(502).json({ error: 'account_sync_failed', detail: message });
  }
});
