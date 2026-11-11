import type { Request, Response } from 'express';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { encodeWorkbenchSnapshot, structureSnapshot } from '@gonglun/core';
import type { snapshot } from './ui-projections.js';
import { measureQueries } from './query-timing.js';

const compress = promisify(gzip);

/** Also compress direct Node/SSH rehearsal traffic, which bypasses Caddy. */
export async function sendSnapshot(req: Request, res: Response, load: () => ReturnType<typeof snapshot>) {
  const start = performance.now();
  let projected = start, filtered = start;
  const measured = await measureQueries(async () => {
    let data = await load();
    projected = performance.now();
    if(res.locals.reviewSanitize)data=await res.locals.reviewSanitize(data);
    filtered = performance.now();
    return data;
  });
  let data = measured.value;
  if (req.query.detail === 'structure') data = structureSnapshot(data);
  const body = JSON.stringify(req.query.format === 'compact-v1' ? encodeWorkbenchSnapshot(data) : data);
  const encoded = performance.now();
  const timings = [`projection;dur=${(projected - start).toFixed(1)}`, `moderation;dur=${(filtered - projected).toFixed(1)}`,
    `db;dur=${measured.ms.toFixed(1)};desc="${measured.count} queries"`, `encode;dur=${(encoded - filtered).toFixed(1)}`];
  res.type('json').vary('Accept-Encoding').set('Cache-Control', 'private, no-store');
  if (Buffer.byteLength(body) >= 1024 && req.acceptsEncodings('gzip', 'identity') === 'gzip') {
    const compressed = await compress(body, { level: 4 });
    timings.push(`gzip;dur=${(performance.now() - encoded).toFixed(1)}`);
    res.set('Server-Timing', timings.join(', ')).set('Content-Encoding', 'gzip').send(compressed);
  } else {
    res.set('Server-Timing', timings.join(', ')).send(body);
  }
}
