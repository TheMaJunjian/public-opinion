import type { Message } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
import { feedSchema } from '../../server/src/feed-schema.js';
import { indexFeedMessages } from '../../server/src/feed-index.js';

/** Rebuildable query data only; messages, balances and execution history are unchanged. */
export async function migrateDiscoveryFeed(store: Store) {
  await store.db.exec(feedSchema);
  let after = '';
  while (true) {
    const rows = await store.db.prepare('SELECT id,body FROM messages WHERE id>$1 ORDER BY id LIMIT 250').all<{ id: string; body: string }>(after);
    if (!rows.length) break;
    await indexFeedMessages(store, rows.map(row => JSON.parse(row.body) as Message));
    after = rows.at(-1)!.id;
  }
}
