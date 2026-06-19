import express from 'express';
import cors from 'cors';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import rateLimit from 'express-rate-limit';

import authRouter from './routes/auth';
import topicsRouter from './routes/topics';
import messagesRouter from './routes/messages';
import relationsRouter from './routes/relations';
import pointsRouter from './routes/points';
import rulesRouter from './routes/rules';
import stakesRouter from './routes/stakes';
import roundsRouter from './routes/rounds';
import stancesRouter from './routes/stances';
import debugLogRouter from './routes/debugLog';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors());
app.use(express.json());

// Rate limiters
// Rate limiters — higher limits in test environments to avoid interference
const writeLimiterMax = process.env.NODE_ENV === 'test' ? 1000 : 600;
const authLimiterMax = process.env.NODE_ENV === 'test' ? 1000 : 20;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: authLimiterMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});

// 写操作限流（仅限 POST / PATCH / DELETE）
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: writeLimiterMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
});

// Load OpenAPI spec and mount Swagger UI
// __dirname is dist/ in production, src/ in dev; openapi.yaml lives in src/
const swaggerDocument = YAML.load(path.join(__dirname, '..', 'src', 'openapi.yaml')) as Record<string, unknown>;
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// API routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/topics', writeLimiter, topicsRouter);
app.use('/api/topics/:topicId/messages', writeLimiter, messagesRouter);
app.use('/api/topics/:topicId/relations', writeLimiter, relationsRouter);
app.use('/api/points', pointsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/messages/:id/stakes', writeLimiter, stakesRouter);
app.use('/', writeLimiter, roundsRouter);
app.use('/', writeLimiter, stancesRouter);
app.use('/api/debug-log', debugLogRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler (must be last)
app.use(errorHandler);

export default app;
