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
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors());
app.use(express.json());

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});

// Load OpenAPI spec and mount Swagger UI
const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml')) as Record<string, unknown>;
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// API routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/topics', writeLimiter, topicsRouter);
app.use('/api/topics/:topicId/messages', writeLimiter, messagesRouter);
app.use('/api/topics/:topicId/relations', writeLimiter, relationsRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler (must be last)
app.use(errorHandler);

export default app;
