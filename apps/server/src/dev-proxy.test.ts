import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import type { Session } from '@gonglun/core';
import webConfig from '../../../frontend/vite.config.js';
import { createApp } from './app.js';
import { createTestApp, cleanupTestDatabases, newTestSchema } from './test-database.js';

it('registers, logs in and sends through the actual development proxy while rejecting foreign origins', async () => {
  const app = (await createTestApp());
  const backend = app.listen(0, '127.0.0.1');
  let web: ViteDevServer | undefined;
  try {
    await once(backend, 'listening');
    const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const configured = webConfig.server!.proxy!['/api']!;
    web = await createServer({
      ...webConfig, configFile: false, logLevel: 'silent',
      server: { ...webConfig.server, host: '127.0.0.1', port: 0, strictPort: false,
        proxy: { '/api': typeof configured === 'string' ? target : { ...configured, target } },
      },
    });
    await web.listen();
    const origin = `http://127.0.0.1:${(web.httpServer!.address() as AddressInfo).port}`;
    const credentials = { name: 'proxy-test', password: 'local-test-password' };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
    });
    const registration = await post('/register', credentials);
    const registrationBody = await registration.json() as Session;
    expect(registration.status, JSON.stringify(registrationBody)).toBe(201);
    const login = await post('/login', credentials);
    const session = await login.json() as Session;
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const input = { recommendation: 1, requestId: randomUUID(), parts: [{ id: 'body', type: 'text', text: '通过开发页面发言' }] };
    const headers = { Cookie: cookie, 'x-csrf-token': session.csrf };
    expect((await post('/messages', input, headers)).status).toBe(201);
    const before = (await app.store.latestSequence());
    const rejected = await post('/messages', { ...input, requestId: randomUUID() }, { ...headers, Origin: 'https://foreign.example' });
    expect(rejected.status).toBe(403);
    expect((await app.store.latestSequence())).toBe(before);
    expect((await post('/register', { ...credentials, name: 'blocked' }, { Origin: 'https://foreign.example' })).status).toBe(403);
  } finally {
    await web?.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    (await app.close());await cleanupTestDatabases();
  }
});
