import { Request, Response } from 'express';
import { pool } from '../config/db';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

const PAGE_SIZE = 10;

function parsePage(param: unknown): number {
  const num = Number(param);
  if (Number.isNaN(num) || num < 0) return 0;
  return num;
}

export async function listPosts(req: Request, res: Response): Promise<Response> {
  const page = parsePage(req.query.page);
  const sort = (req.query.sort as string) || 'latest';
  const orderBy = sort === 'latest' ? 'p.created_at DESC' : 'p.id DESC';
  const offset = page * PAGE_SIZE;

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT 
        p.id,
        p.title,
        p.view_count AS view,
        p.like_count AS \`like\`,
        p.comment_count AS comment,
        p.created_at AS createdAt,
        u.nickname AS writer
      FROM posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
      `,
      [PAGE_SIZE, offset]
    );
    return res.status(200).json(rows);
  } catch (err) {
    console.error('[community][list] DB error:', err);
    return res.status(500).json({ error: 'posts_fetch_failed' });
  }
}

export async function getPostDetail(req: Request, res: Response): Promise<Response> {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_post_id' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE posts SET view_count = view_count + 1 WHERE id = ?`,
      [id]
    );

    const [postRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT 
        p.id,
        p.title,
        p.content,
        p.view_count AS view,
        p.like_count AS \`like\`,
        p.comment_count AS comment,
        p.created_at AS createdAt,
        u.id AS writerId,
        u.nickname AS writerNick,
        u.profile_image AS writerImg
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = ?
      LIMIT 1
      `,
      [id]
    );

    const post = postRows[0];
    if (!post) {
      await conn.rollback();
      return res.status(404).json({ error: 'post_not_found' });
    }

    const [commentRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT 
        c.id,
        c.content AS text,
        c.created_at AS createdAt,
        u.id AS userId,
        u.nickname AS user
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
      `,
      [id]
    );

    await conn.commit();

    return res.status(200).json({
      id: post.id,
      title: post.title,
      content: post.content,
      writer: {
        id: post.writerId,
        nick: post.writerNick,
        img: post.writerImg,
      },
      view: post.view,
      like: post.like,
      comment: post.comment,
      createdAt: post.createdAt,
      comments: commentRows,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[community][detail] DB error:', err);
    return res.status(500).json({ error: 'post_fetch_failed' });
  } finally {
    conn.release();
  }
}

export async function createPost(req: Request, res: Response): Promise<Response> {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { title, content } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title_required' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content_required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)`,
      [userId, title, content]
    );

    await conn.execute(
      `UPDATE users SET post_count = post_count + 1 WHERE id = ?`,
      [userId]
    );

    await conn.commit();

    const postId = result.insertId;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT created_at AS createdAt FROM posts WHERE id = ? LIMIT 1`,
      [postId]
    );

    return res.status(201).json({
      postId,
      createdAt: rows[0]?.createdAt,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[community][create] DB error:', err);
    return res.status(500).json({ error: 'post_create_failed' });
  } finally {
    conn.release();
  }
}
