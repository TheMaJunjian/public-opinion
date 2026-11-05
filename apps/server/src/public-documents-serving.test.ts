import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { publicDocsPlugin, publicDocuments } from '../../../frontend/publicDocsPlugin';

it('serves README documents and their original text without login or client scripts', async () => {
  // A test server must not replace the dependency cache of a running dev page.
  const cacheDir = await mkdtemp(join(tmpdir(), 'gonglun-public-documents-'));
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root: fileURLToPath(new URL('../../../frontend', import.meta.url)), configFile: false, cacheDir,
      plugins: [publicDocsPlugin()], server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing document test server');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const entry of publicDocuments) {
      const response = await fetch(`${origin}/docs/${entry.slug}.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html; charset=utf-8');
      const html = await response.text();
      expect(html).toContain(`<h1>${entry.title}</h1>`);
      expect(html).not.toContain('<script');
      expect(html).toContain(`href="/docs/${entry.slug}.html" aria-current="page"`);
      const raw = await fetch(`${origin}/docs/${entry.slug}.md`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get('content-type')).toContain('text/markdown; charset=utf-8');
      expect(await raw.text()).toBe(await readFile(new URL(`../../../${entry.source}`, import.meta.url), 'utf8'));
    }
  } finally {
    try { await server?.close(); }
    finally { await rm(cacheDir, { recursive: true, force: true }); }
  }
});
