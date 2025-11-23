import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { listTransactions, getTransactionDetail } from '../controllers/transactionController';

const transactionsRouter = Router();

transactionsRouter.get('/', requireAuth, listTransactions);
transactionsRouter.get('/:id', requireAuth, getTransactionDetail);

export default transactionsRouter;
