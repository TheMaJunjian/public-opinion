import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { webAssets } from './web.js';

it('revalidates entries and deployment metadata, caches hashed assets and preserves missing-module errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gonglun-web-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<html>公论</html>');
    await writeFile(join(directory, 'build.json'), '{"id":"release-a"}');
    await writeFile(join(directory, 'assets', 'index-hash.js'), 'export {};');
    const app = express().use(webAssets(directory));
    for (const path of ['/', '/index.html', '/viewer', '/build.json']) {
      expect((await request(app).get(path).expect(200)).headers['cache-control']).toBe('no-store');
    }
    expect((await request(app).get('/assets/index-hash.js').expect(200)).headers['cache-control']).toContain('immutable');
    await request(app).get('/assets/missing.js').expect(404);
    await writeFile(join(directory, 'build.json'), '{"id":"release-b"}');
    expect((await request(app).get('/build.json').expect(200)).body).toEqual({ id: 'release-b' });
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory).startsWith('gonglun-web-')).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
