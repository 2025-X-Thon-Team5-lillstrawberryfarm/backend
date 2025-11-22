import { Router, Request, Response } from 'express';

const mainRouter = Router();

mainRouter.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from the API root' });
});

export default mainRouter;
