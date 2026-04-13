import express from 'express';
import cors from 'cors';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

import authRouter from './routes/auth';
import topicsRouter from './routes/topics';
import messagesRouter from './routes/messages';
import relationsRouter from './routes/relations';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors());
app.use(express.json());

// Load OpenAPI spec and mount Swagger UI
const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml')) as Record<string, unknown>;
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// API routes
app.use('/api/auth', authRouter);
app.use('/api/topics', topicsRouter);
app.use('/api/topics/:topicId/messages', messagesRouter);
app.use('/api/topics/:topicId/relations', relationsRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler (must be last)
app.use(errorHandler);

export default app;
