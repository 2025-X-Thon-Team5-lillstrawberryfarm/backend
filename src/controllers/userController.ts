import { Request, Response } from 'express';
import { pool } from '../config/db';
import { RowDataPacket } from 'mysql2';

interface ProfileRow extends RowDataPacket {
  id: number;
  nickname: string;
  cluster_name: string | null;
  post_count: number | null;
  follower_count: number | null;
  following_count: number | null;
}

export async function getMyProfile(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const [rows] = await pool.execute<ProfileRow[]>(
      `
      SELECT 
        u.id,
        u.nickname,
        c.name AS cluster_name,
        u.post_count,
        u.follower_count,
        u.following_count
      FROM users u
      LEFT JOIN clusters c ON u.cluster_id = c.id
      WHERE u.id = ?
      LIMIT 1
      `,
      [userId]
    );

    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    return res.status(200).json({
      userId: user.id,
      nick: user.nickname,
      clusterName: user.cluster_name,
      counts: {
        post: user.post_count ?? 0,
        follower: user.follower_count ?? 0,
        following: user.following_count ?? 0,
      },
    });
  } catch (err) {
    console.error('[users][getMyProfile] DB error:', err);
    return res.status(500).json({ error: 'profile_fetch_failed' });
  }
}
