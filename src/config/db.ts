import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_CONNECTION_LIMIT,
  DB_CONNECT_TIMEOUT,
} = process.env;

if (!DB_HOST || !DB_USER || !DB_NAME) {
  throw new Error('DB_HOST, DB_USER, DB_NAME 환경변수가 필요합니다.');
}

export const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT ? Number(DB_PORT) : 3306,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT ? Number(DB_CONNECTION_LIMIT) : 10,
  connectTimeout: DB_CONNECT_TIMEOUT ? Number(DB_CONNECT_TIMEOUT) : 10_000,
  charset: 'utf8mb4',
});

export async function healthCheck(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}
