import { Router, Request, Response } from 'express';
import bankRouter from './bank';
import authRouter from './auth';
import usersRouter from './users';
import transactionsRouter from './transactions';

const mainRouter = Router();

mainRouter.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from the API root' });
});

mainRouter.use('/auth', authRouter);
mainRouter.use('/users', usersRouter);
mainRouter.use('/transactions', transactionsRouter);
mainRouter.use('/bank', bankRouter);

export default mainRouter;
