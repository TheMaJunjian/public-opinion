import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES } from '@gonglun/core';
import type { Store } from './db.js';
import { schemaSql } from './schema.js';
import { initializeProjections } from './projections.js';
import { initializePersonal } from './personal-actions.js';

/** Initializes an empty database using the current schema, without historical upgrades. */
export async function initializeDatabase(store: Store): Promise<void> {
  await store.db.exec(schemaSql);
  for (const [key,value] of Object.entries({rules:DEFAULT_RULES,operating:0,region:randomUUID(),minted:0,'access-mode':'read-write','retired-organizations':[]}))
    await store.db.prepare('INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO NOTHING').run(key,JSON.stringify(value));
  await store.db.prepare('INSERT INTO rule_versions VALUES ($1,$2,NULL,$3) ON CONFLICT(version) DO NOTHING')
    .run(DEFAULT_RULES.version,JSON.stringify(DEFAULT_RULES),new Date().toISOString());
  await initializeProjections(store);
  await initializePersonal(store);
}
