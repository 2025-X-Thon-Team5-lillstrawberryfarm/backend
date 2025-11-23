import { Request, Response } from 'express';
import { pool } from '../config/db';
import { RowDataPacket } from 'mysql2';

interface TransactionRow extends RowDataPacket {
  id: number;
  transacted_at: string | Date;
  store_name: string | null;
  original_content: string | null;
  type: 'DEPOSIT' | 'WITHDRAW';
  amount: number;
  category: string | null;
}

interface TransactionDetailRow extends RowDataPacket {
  id: number;
  transacted_at: string | Date;
  store_name: string | null;
  original_content: string | null;
  amount: number;
  balance_after: number | null;
  method: string | null;
  memo: string | null;
  is_excluded: number | boolean | null;
}

function parseYearMonth(yyyymm: string): { start: string; end: string } | null {
  if (!/^\d{6}$/.test(yyyymm)) return null;
  const year = Number(yyyymm.slice(0, 4));
  const month = Number(yyyymm.slice(4, 6)); // 1-12
  if (month < 1 || month > 12) return null;

  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  const toSql = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;

  return { start: toSql(startDate), end: toSql(endDate) };
}

function formatDateParts(date: Date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return { date: `${mm}.${dd}`, time: `${hh}:${mi}` };
}

function formatFullDate(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd} ${hh}:${mi}`;
}

export async function listTransactions(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { date, page } = req.query;
  if (!date || typeof date !== 'string') {
    return res.status(400).json({ error: 'date_required' });
  }

  const range = parseYearMonth(date);
  if (!range) {
    return res.status(400).json({ error: 'invalid_date_format', detail: 'use YYYYMM' });
  }

  const pageNumberRaw = page ? Number(page) : 0;
  if (Number.isNaN(pageNumberRaw) || pageNumberRaw < 0) {
    return res.status(400).json({ error: 'invalid_page' });
  }

  const PAGE_SIZE = 20;
  const offset = pageNumberRaw * PAGE_SIZE;

  try {
    // LIMIT/OFFSET에 placeholder 사용 시 MySQL 버전에 따라 오류가 날 수 있어 inline 숫자로 처리
    const limit = PAGE_SIZE + 1;
    const sql = `
      SELECT id, transacted_at, store_name, original_content, type, amount, category
      FROM transactions
      WHERE user_id = ?
        AND DATE_FORMAT(transacted_at, '%Y%m') = ?
      ORDER BY transacted_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [rows] = await pool.query<TransactionRow[]>(sql, [userId, date]);

    const items = rows.slice(0, PAGE_SIZE).map((row) => {
      const dt = new Date(row.transacted_at);
      const { date: dateStr, time } = formatDateParts(dt);
      return {
        id: row.id,
        date: dateStr,
        time,
        store: row.store_name || row.original_content || '',
        type: row.type,
        amt: row.amount,
        category: row.category,
      };
    });

    const last = rows.length <= PAGE_SIZE;

    return res.status(200).json({
      content: items,
      last,
    });
  } catch (err) {
    console.error('[transactions][list] DB error:', err);
    const detail =
      err instanceof Error
        ? { message: err.message, name: err.name }
        : { message: String(err) };
    return res.status(500).json({ error: 'transactions_fetch_failed', detail });
  }
}

export async function getTransactionDetail(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const [rows] = await pool.execute<TransactionDetailRow[]>(
      `
      SELECT id, transacted_at, store_name, original_content, amount, balance_after, method, memo, is_excluded
      FROM transactions
      WHERE id = ? AND user_id = ?
      LIMIT 1
      `,
      [id, userId]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'transaction_not_found' });
    }

    const fullDate = formatFullDate(new Date(row.transacted_at));
    return res.status(200).json({
      id: row.id,
      store: row.store_name || row.original_content || '',
      fullDate,
      amt: row.amount,
      balance: row.balance_after,
      method: row.method,
      memo: row.memo ?? '',
      isExcluded: Boolean(row.is_excluded),
    });
  } catch (err) {
    console.error('[transactions][detail] DB error:', err);
    return res.status(500).json({ error: 'transaction_fetch_failed' });
  }
}
