import { Router, Request, Response } from 'express';
import crypto from 'crypto';

type ConnectRequestBody = {
  kftcAuthCode?: string;
  scope?: string;
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

bankRouter.post('/connect', async (req: Request, res: Response) => {
  const { kftcAuthCode, scope }: ConnectRequestBody = req.body || {};

  if (!kftcAuthCode) {
    return res.status(400).json({ error: 'kftcAuthCode is required' });
  }

  const requestedScope = scope || 'login transfer';

  try {
    const tokenResponse = await exchangeAuthCode(kftcAuthCode, requestedScope);

    return res.status(200).json({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenType: tokenResponse.token_type,
      expiresIn: tokenResponse.expires_in,
      scope: tokenResponse.scope,
      userSeqNo: tokenResponse.user_seq_no,
      raw: tokenResponse, // keep raw response for downstream needs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    console.error('[KFTC][connect] token exchange failed:', message);
    return res.status(502).json({ error: 'Failed to exchange kftcAuthCode', detail: message });
  }
});

export default bankRouter;
