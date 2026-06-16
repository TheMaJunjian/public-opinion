import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'README', 'logs');
const LOG_FILE = () => path.join(LOG_DIR, `frontend-${new Date().toISOString().slice(0, 10)}.log`);

router.post('/', (req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const { tag, msg } = req.body;
    fs.appendFileSync(LOG_FILE(), `[${tag}] ${msg}\n`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

export default router;
