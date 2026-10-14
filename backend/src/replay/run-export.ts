/**
 * Replay an economic audit export without a database connection.
 * Usage: npm run replay:export -- path/to/audit-export.json
 */

import fs from 'node:fs';
import { replayFromAuditExport, type EconomicAuditExportSnapshot } from './replay';

const filePath = process.argv[2];

if (!filePath) {
  console.error('[replay-export] missing input file');
  process.exit(2);
}

try {
  const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EconomicAuditExportSnapshot;
  const state = replayFromAuditExport(snapshot);
  const settled = [...state.rounds.values()].filter(round => round.status === 'SETTLED').length;

  console.log(`[replay-export] topic=${snapshot.topicId}`);
  console.log(`[replay-export] stakes=${state.stakes.length} votes=${[...state.votes.values()].reduce((total, votes) => total + votes.length, 0)} rounds=${state.rounds.size} settled=${settled}`);
  console.log('[replay-export] topic-local economic state rebuilt; global balance conservation requires a full audit export.');
} catch (err) {
  console.error(`[replay-export] FAILED: ${(err as Error).message}`);
  process.exit(1);
}
