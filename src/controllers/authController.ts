import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import jwt, { SignOptions } from 'jsonwebtoken';

function hashPassword(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET 환경변수가 필요합니다.');
  }
  return secret;
}

export async function signup(req: Request, res: Response): Promise<Response> {
  const { email, pw, nickname, agreed } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email_required' });
  }
  if (!pw || typeof pw !== 'string') {
    return res.status(400).json({ error: 'pw_required' });
  }
  if (!nickname || typeof nickname !== 'string') {
    return res.status(400).json({ error: 'nickname_required' });
  }
  if (agreed !== true) {
    return res.status(400).json({ error: 'terms_not_agreed' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  if (pw.length < 8) {
    return res.status(400).json({ error: 'pw_too_short' });
  }

  const hashedPw = hashPassword(pw);

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO users (email, password, nickname) VALUES (?, ?, ?)',
      [email, hashedPw, nickname]
    );

    return res.status(201).json({
      userId: result.insertId,
      message: '가입 성공',
    });
  } catch (err) {
    const anyErr = err as any;
    if (anyErr?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'email_exists' });
    }

    console.error('[auth][signup] DB error:', err);
    return res.status(500).json({ error: 'signup_failed' });
  }
}

export async function login(req: Request, res: Response): Promise<Response> {
  const { email, pw } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email_required' });
  }
  if (!pw || typeof pw !== 'string') {
    return res.status(400).json({ error: 'pw_required' });
  }

  const hashedPw = hashPassword(pw);
  const signOptions: SignOptions = {};
  if (process.env.JWT_EXPIRES_IN && process.env.JWT_EXPIRES_IN !== 'never') {
    signOptions.expiresIn = (process.env.JWT_EXPIRES_IN) as unknown as SignOptions['expiresIn'];
  }

  interface UserRow extends RowDataPacket {
    id: number;
    password: string;
  }

  try {
    const [rows] = await pool.execute<UserRow[]>(
      'SELECT id, password FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    if (user.password !== hashedPw) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = jwt.sign(
      { sub: user.id, email },
      getJwtSecret(),
      signOptions
    );

    return res.status(200).json({
      accessToken: token,
      userId: user.id,
    });
  } catch (err) {
    console.error('[auth][login] DB error:', err);
    return res.status(500).json({ error: 'login_failed' });
  }
}
