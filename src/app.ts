import express, { Request, Response } from 'express';
// import cors from 'cors';
import mainRouter from './routes';
import dotenv from "dotenv";
dotenv.config();

const app = express();

/*
const allowedOrigins = process.env.CORS_ORIGIN
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  })
);
*/

// Body parsing
app.use(express.json());

// Mount routers
app.use('/', mainRouter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

export default app;
