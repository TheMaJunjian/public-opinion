import { Router } from 'express';
import { log, debugLog } from '../lib/logger';

const router = Router();

router.post('/', (req, res) => {
  try {
    const { tag, msg, debug } = req.body;
    if (debug) {
      debugLog(tag, msg);
    } else {
      log(tag, msg);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

export default router;
