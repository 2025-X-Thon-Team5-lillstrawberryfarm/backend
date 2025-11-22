import { UserContext } from '../types/user';

declare global {
  namespace Express {
    interface Request {
      user?: UserContext;
    }
  }
}

export {};
