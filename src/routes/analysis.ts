import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getMyGroup, getClusterStats } from '../controllers/analysisController';

const analysisRouter = Router();

// GET /analysis/clustering/my-group - 내 그룹 정보 조회
analysisRouter.get('/clustering/my-group', requireAuth, getMyGroup);

// GET /analysis/clustering/stats - 그룹 카테고리별 통계
analysisRouter.get('/clustering/stats', requireAuth, getClusterStats);

export default analysisRouter;
