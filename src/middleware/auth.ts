import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

type DecodedToken = jwt.JwtPayload & {
  sub?: string | number;
  email?: string;
};

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET 환경변수가 필요합니다.');
  }
  return secret;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || typeof authHeader !== 'string') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: 'invalid_authorization_header' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as DecodedToken;
    const userId = decoded.sub ?? decoded.id;

    if (!userId) {
      return res.status(401).json({ error: 'invalid_token_payload' });
    }

    req.user = {
      id: typeof userId === 'string' ? Number(userId) : userId,
      email: decoded.email,
      token,
    };

    return next();
  } catch (err) {
    console.error('[auth][middleware] token verify failed:', err);
    return res.status(401).json({ error: 'invalid_token' });
  }
}
