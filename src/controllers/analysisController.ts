import { Request, Response } from 'express';
import { pool } from '../config/db';
import { RowDataPacket } from 'mysql2';

interface ClusterRow extends RowDataPacket {
  id: number;
  name: string;
  min_amount: number;
  max_amount: number;
  description: string | null;
}

interface ClusterStatRow extends RowDataPacket {
  category: string;
  avg_spend_amount: number;
}

// GET /analysis/clustering/my-group - 내 그룹 정보 조회
export async function getMyGroup(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const [rows] = await pool.query<(RowDataPacket & { cluster_id: number | null })[]>(
      `SELECT cluster_id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    const clusterId = rows[0]?.cluster_id;
    if (!clusterId) {
      return res.status(200).json({
        clusterId: null,
        name: null,
        range: null,
      });
    }

    const [clusterRows] = await pool.query<ClusterRow[]>(
      `SELECT id, name, min_amount, max_amount, description FROM clusters WHERE id = ? LIMIT 1`,
      [clusterId]
    );

    const cluster = clusterRows[0];
    if (!cluster) {
      return res.status(200).json({
        clusterId: null,
        name: null,
        range: null,
      });
    }

    return res.status(200).json({
      clusterId: cluster.id,
      name: cluster.name,
      range: {
        min: cluster.min_amount,
        max: cluster.max_amount,
      },
      description: cluster.description,
    });
  } catch (err) {
    console.error('[analysis][my-group] DB error:', err);
    return res.status(500).json({ error: 'cluster_fetch_failed' });
  }
}

// GET /analysis/clustering/stats - 그룹 카테고리별 통계
export async function getClusterStats(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const date = req.query.date as string | undefined; // YYYY-MM format

  try {
    // 사용자의 클러스터 조회
    const [userRows] = await pool.query<(RowDataPacket & { cluster_id: number | null })[]>(
      `SELECT cluster_id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    const clusterId = userRows[0]?.cluster_id;
    if (!clusterId) {
      return res.status(200).json({
        groupName: null,
        stats: [],
      });
    }

    // 클러스터 이름 조회
    const [clusterRows] = await pool.query<(RowDataPacket & { name: string })[]>(
      `SELECT name FROM clusters WHERE id = ? LIMIT 1`,
      [clusterId]
    );
    const groupName = clusterRows[0]?.name || null;

    // 통계 조회
    let statsQuery = `
      SELECT category, avg_spend_amount
      FROM cluster_stats
      WHERE cluster_id = ?
    `;
    const params: (number | string)[] = [clusterId];

    if (date) {
      statsQuery += ` AND target_month = ?`;
      params.push(date);
    } else {
      // 가장 최근 월 데이터 조회
      statsQuery += ` AND target_month = (
        SELECT MAX(target_month) FROM cluster_stats WHERE cluster_id = ?
      )`;
      params.push(clusterId);
    }

    statsQuery += ` ORDER BY avg_spend_amount DESC`;

    const [statsRows] = await pool.query<ClusterStatRow[]>(statsQuery, params);

    const stats = statsRows.map((row) => ({
      cat: row.category,
      avg: Number(row.avg_spend_amount) || 0,
    }));

    return res.status(200).json({
      groupName,
      stats,
    });
  } catch (err) {
    console.error('[analysis][cluster-stats] DB error:', err);
    return res.status(500).json({ error: 'cluster_stats_fetch_failed' });
  }
}
