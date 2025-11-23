import { Router } from 'express';
import { listPosts, getPostDetail, createPost } from '../controllers/communityController';
import { requireAuth } from '../middleware/auth';

const communityRouter = Router();

// GET /community/posts - 전체 글 목록
communityRouter.get('/posts', listPosts);

// GET /community/posts/:id - 글 상세
communityRouter.get('/posts/:id', getPostDetail);

// POST /community/posts - 글 작성 (인증 필요)
communityRouter.post('/posts', requireAuth, createPost);

export default communityRouter;
