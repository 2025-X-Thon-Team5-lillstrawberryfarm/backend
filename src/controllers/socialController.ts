import { Request, Response } from 'express';
import { pool } from '../config/db';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

function toNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

export async function followUser(req: Request, res: Response): Promise<Response> {
  const followerId = req.user?.id;
  if (!followerId) return res.status(401).json({ error: 'unauthorized' });

  const targetId = toNumber(req.body?.targetId);
  if (!targetId) return res.status(400).json({ error: 'target_required' });
  if (targetId === followerId) return res.status(400).json({ error: 'cannot_follow_self' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await conn.execute(
        `INSERT INTO follows (follower_id, following_id) VALUES (?, ?)`,
        [followerId, targetId]
      );
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') {
        await conn.rollback();
        return res.status(200).json({ status: 'ALREADY_FOLLOWING' });
      }
      throw err;
    }

    await conn.execute(
      `UPDATE users SET following_count = following_count + 1 WHERE id = ?`,
      [followerId]
    );
    await conn.execute(
      `UPDATE users SET follower_count = follower_count + 1 WHERE id = ?`,
      [targetId]
    );
    await conn.commit();

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT nickname FROM users WHERE id = ? LIMIT 1`,
      [targetId]
    );
    const targetNick = rows[0]?.nickname || '익명';

    return res.status(200).json({ status: 'FOLLOWING', targetNick });
  } catch (err) {
    await conn.rollback();
    console.error('[social][follow] error:', err);
    return res.status(500).json({ error: 'follow_failed' });
  } finally {
    conn.release();
  }
}

export async function listFollowing(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT u.id AS userId, u.nickname AS nick, u.profile_image AS img
      FROM follows f
      JOIN users u ON u.id = f.following_id
      WHERE f.follower_id = ?
      ORDER BY u.id DESC
      `,
      [userId]
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.error('[social][following] error:', err);
    return res.status(500).json({ error: 'following_fetch_failed' });
  }
}

export async function listClusterMembers(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const [clusterRows] = await pool.query<RowDataPacket[]>(
      `SELECT cluster_id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const clusterId = clusterRows[0]?.cluster_id;
    if (!clusterId) return res.status(200).json([]);

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT 
        u.id AS userId,
        u.nickname AS nick,
        u.profile_image AS img,
        stats.total_spend AS spendAmount,
        stats.prev_month_comparison AS growthRate,
        IF(f.follower_id IS NULL, FALSE, TRUE) AS isFollowing
      FROM users u
      LEFT JOIN (
        SELECT ums.user_id, ums.total_spend, ums.prev_month_comparison
        FROM user_monthly_stats ums
        WHERE (ums.user_id, ums.target_month) IN (
          SELECT user_id, MAX(target_month) AS max_month
          FROM user_monthly_stats
          GROUP BY user_id
        )
      ) stats ON stats.user_id = u.id
      LEFT JOIN follows f ON f.follower_id = ? AND f.following_id = u.id
      WHERE u.cluster_id = ? AND u.id <> ?
      ORDER BY u.id DESC
      `,
      [userId, clusterId, userId]
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.error('[social][group members] error:', err);
    return res.status(500).json({ error: 'cluster_members_fetch_failed' });
  }
}

export async function listFollowers(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT u.id AS userId, u.nickname AS nick, u.profile_image AS img
      FROM follows f
      JOIN users u ON u.id = f.follower_id
      WHERE f.following_id = ?
      ORDER BY f.id DESC
      `,
      [userId]
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.error('[social][followers] error:', err);
    return res.status(500).json({ error: 'followers_fetch_failed' });
  }
}

export async function getSocialReport(req: Request, res: Response): Promise<Response> {
  const targetId = Number(req.params.userId);
  if (Number.isNaN(targetId)) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }

  try {
    const [userRows] = await pool.query<RowDataPacket[]>(
      `SELECT nickname AS nick FROM users WHERE id = ? LIMIT 1`,
      [targetId]
    );
    const nick = userRows[0]?.nick || '익명';

    const [statsRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT category, SUM(total_spend) AS spend
      FROM (
        SELECT
          t.category,
          SUM(t.amount) AS total_spend
        FROM transactions t
        WHERE t.user_id = ?
          AND t.is_excluded = FALSE
          AND t.category IS NOT NULL
        GROUP BY t.category
      ) c
      GROUP BY category
      ORDER BY spend DESC
      `,
      [targetId]
    );

    const totalSpend = statsRows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);
    const pattern: Record<string, number> = {};
    for (const row of statsRows) {
      const spend = Number(row.spend) || 0;
      pattern[row.category] = totalSpend > 0 ? Math.round((spend / totalSpend) * 100) : 0;
    }
    const fav = statsRows[0]?.category || null;

    return res.status(200).json({
      nick,
      fav,
      pattern,
    });
  } catch (err) {
    console.error('[social][report] error:', err);
    return res.status(500).json({ error: 'social_report_fetch_failed' });
  }
}
