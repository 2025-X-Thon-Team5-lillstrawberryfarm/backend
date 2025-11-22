import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getMyProfile } from '../controllers/userController';

const usersRouter = Router();

usersRouter.get('/profile', requireAuth, getMyProfile);

export default usersRouter;
