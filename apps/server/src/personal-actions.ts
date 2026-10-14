import { relations, targets, type Message } from '@gonglun/core';
import type { Store } from './db.js';

const families: Record<string, string> = { read: 'read', unread: 'read', follow: 'follow', unfollow: 'follow', block: 'block', unblock: 'block', archive: 'archive', unarchive: 'archive' };

/** Personal actions execute once when a message is sent, independently of later edits. */
export function recordPersonal(store: Store, message: Message) {
  if (message.authorId === 'system' || message.revision !== 1) return;
  const insert = store.db.prepare('INSERT OR IGNORE INTO personal_actions(authorId,targetId,family,action,sequence,sourceId,partId,partOrder) VALUES (?,?,?,?,?,?,?,?)');
  const latest = store.db.prepare(`INSERT INTO personal_marks(authorId,targetId,family,action,sequence,sourceId,partId,partOrder) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(authorId,targetId,family) DO UPDATE SET action=excluded.action,sequence=excluded.sequence,sourceId=excluded.sourceId,partId=excluded.partId,partOrder=excluded.partOrder
    WHERE excluded.sequence>personal_marks.sequence OR (excluded.sequence=personal_marks.sequence AND (excluded.sourceId>personal_marks.sourceId OR (excluded.sourceId=personal_marks.sourceId AND excluded.partOrder>personal_marks.partOrder)))`);
  for (const part of relations(message)) {
    const family = families[part.relation]; if (!family) continue;
    const partOrder = message.parts.indexOf(part);
    for (const reference of targets(part, 'target')) {
      const values = [message.authorId, reference.messageId, family, part.relation, message.sequence, message.id, part.id, partOrder] as const;
      if (insert.run(...values).changes) latest.run(...values);
    }
  }
}

export function initializePersonal(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS personal_actions(authorId TEXT NOT NULL,targetId TEXT NOT NULL,family TEXT NOT NULL,action TEXT NOT NULL,sequence INTEGER NOT NULL,sourceId TEXT NOT NULL,partId TEXT NOT NULL,partOrder INTEGER NOT NULL,PRIMARY KEY(sourceId,partId,targetId));
    CREATE INDEX IF NOT EXISTS personal_action_owner ON personal_actions(authorId,targetId,family,sequence);
    CREATE TABLE IF NOT EXISTS personal_marks(authorId TEXT NOT NULL,targetId TEXT NOT NULL,family TEXT NOT NULL,action TEXT NOT NULL,sequence INTEGER NOT NULL,sourceId TEXT NOT NULL,partId TEXT NOT NULL,partOrder INTEGER NOT NULL,PRIMARY KEY(authorId,targetId,family));
    CREATE INDEX IF NOT EXISTS personal_mark_filter ON personal_marks(authorId,family,action,targetId);`);
  if (store.db.prepare("SELECT 1 FROM settings WHERE key='personal_projection_v1'").get()) return;
  store.transaction(() => {
    // Migration reads immutable sending revisions exactly once, never edited current bodies.
    for (const row of store.db.prepare('SELECT body FROM revisions WHERE revision=1').iterate()) recordPersonal(store, JSON.parse(String(row.body)) as Message);
    store.set('personal_projection_v1', true);
  });
}
