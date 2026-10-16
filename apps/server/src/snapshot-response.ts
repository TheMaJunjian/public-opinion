import type { Request, Response } from 'express';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { encodeWorkbenchSnapshot } from '@gonglun/core';
import type { snapshot } from './ui-projections.js';

const compress = promisify(gzip);

/** Also compress direct Node/SSH rehearsal traffic, which bypasses Caddy. */
export async function sendSnapshot(req: Request, res: Response, data: Awaited<ReturnType<typeof snapshot>>) {
  const body = JSON.stringify(req.query.format === 'compact-v1' ? encodeWorkbenchSnapshot(data) : data);
  res.type('json').vary('Accept-Encoding').set('Cache-Control', 'private, no-store');
  if (Buffer.byteLength(body) >= 1024 && req.acceptsEncodings('gzip', 'identity') === 'gzip') {
    const compressed = await compress(body, { level: 4 });
    res.set('Content-Encoding', 'gzip').send(compressed);
  } else {
    res.send(body);
  }
}
