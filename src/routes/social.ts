import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { followUser, listFollowing, listClusterMembers, getSocialReport } from '../controllers/socialController';

const socialRouter = Router();

// Follow
socialRouter.post('/follow', requireAuth, followUser);

// Following list
socialRouter.get('/following', requireAuth, listFollowing);

// Same cluster members
socialRouter.get('/group/members', requireAuth, listClusterMembers);

// View someone else's report
socialRouter.get('/report/:userId', requireAuth, getSocialReport);

export default socialRouter;
