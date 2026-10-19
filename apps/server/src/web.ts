import express from 'express';
import { resolve, sep } from 'node:path';

/** Entry and version metadata must always see the latest deployment. */
export function webAssets(directory: string) {
  const router = express.Router();
  const assets = resolve(directory, 'assets') + sep;
  router.use(express.static(directory, { setHeaders: (res, file) => {
    res.setHeader('Cache-Control', file.startsWith(assets) ? 'public, max-age=31536000, immutable' : 'no-store');
  } }));
  // Missing hashed modules must remain a 404, not an HTML page served as JavaScript.
  router.use('/assets', (_req, res) => { res.sendStatus(404); });
  router.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(resolve(directory, 'index.html')); });
  return router;
}
