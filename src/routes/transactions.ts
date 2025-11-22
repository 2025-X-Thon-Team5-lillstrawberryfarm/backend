import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { listTransactions } from '../controllers/transactionController';

const transactionsRouter = Router();

transactionsRouter.get('/', requireAuth, listTransactions);

export default transactionsRouter;
