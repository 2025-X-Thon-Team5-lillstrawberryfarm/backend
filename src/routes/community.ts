import { Router } from 'express';
import { listPosts, getPostDetail, createPost, createComment, likePost, deletePost } from '../controllers/communityController';
import { requireAuth } from '../middleware/auth';

const communityRouter = Router();

// GET /community/posts - 전체 글 목록
communityRouter.get('/posts', listPosts);

// GET /community/posts/:id - 글 상세
communityRouter.get('/posts/:id', getPostDetail);

// POST /community/posts - 글 작성 (인증 필요)
communityRouter.post('/posts', requireAuth, createPost);

// POST /community/posts/:id/comments - 댓글 작성
communityRouter.post('/posts/:id/comments', requireAuth, createComment);

// POST /community/posts/:id/like - 게시글 좋아요
communityRouter.post('/posts/:id/like', requireAuth, likePost);

// DELETE /community/posts/:id - 게시글 삭제
communityRouter.delete('/posts/:id', requireAuth, deletePost);

export default communityRouter;
