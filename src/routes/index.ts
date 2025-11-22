import { Router, Request, Response } from 'express';
import bankRouter from './bank';
import authRouter from './auth';

const mainRouter = Router();

mainRouter.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from the API root!' });
});

mainRouter.use('/auth', authRouter);
mainRouter.use('/bank', bankRouter);

export default mainRouter;
