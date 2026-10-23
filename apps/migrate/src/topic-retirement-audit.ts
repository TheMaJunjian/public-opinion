import type {MigrationChange as Change} from './migration-types.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { replayArchive, type Message, type Membership } from '@gonglun/core';

// Deliberately uses direct, read-only SQL, without Store.open or migration helpers.
const [mode, baselinePath, reportPath] = process.argv.slice(2);
if (!['capture', 'verify'].includes(mode) || !baselinePath || mode === 'verify' && !reportPath)
  throw new Error('Usage: tsx --env-file=.env apps/migrate/src/topic-retirement-audit.ts capture BASELINE | verify BASELINE REPORT');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const schema = process.env.DATABASE_SCHEMA ?? 'public';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid schema');
const stable = (value: any): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows.map(row => String(row.tablename));
    const rows: Record<string, any[]> = {};
    for (const table of tables) rows[table] = (await client.query(`SELECT row_to_json(t) AS row FROM "${table.replaceAll('"', '""')}" t`)).rows.map(row => row.row);
    const messages = rows.messages.map(row => JSON.parse(row.body) as Message);
    const topicIds = messages.filter(message => message.parts.some(part => part.type === 'data' && part.value && typeof part.value === 'object'
      && !Array.isArray(part.value) && (part.value.legacyTopicId === message.id || (part.value.origin as any)?.kind==='topic-classification' && (part.value.origin as any)?.id===message.id) && part.value.uiType === 'CLASSIFY')).map(message => message.id).sort();
    const changes = rows.changes.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const replay = replayArchive({ format: 'gonglun-2', changes: changes.map(row => JSON.parse(row.body)) });
    const same = (a: unknown, b: unknown) => stable(a) === stable(b);
    const sorted = (list: any[]) => list.map(stable).sort();
    const memberships = rows.memberships.map(({ position: _position, ...row }) => row);
    const accountMatch = replay.accounts.size === rows.accounts.length && rows.accounts.every(row => same(replay.accounts.get(row.userId), { available: Number(row.available), locked: Number(row.locked), earned: Number(row.earned), spent: Number(row.spent) }));
    const normalizeMembership = (row: Membership) => ({ ...row, sourcePartId: row.sourcePartId ?? null, bindingId: row.bindingId ?? null, sourceRevision: row.sourceRevision ?? null });
    const membershipMatch = same(sorted(memberships.map(normalizeMembership)), sorted(replay.memberships.map(normalizeMembership)));
    const messageMatch = same(sorted(rows.messages.map(row => JSON.parse(row.body))), sorted(replay.messages));
    if (!accountMatch || !membershipMatch || !messageMatch) throw new Error(`Replay mismatch: accounts=${accountMatch}, memberships=${membershipMatch}, messages=${messageMatch}`);
    const snapshot = {
      database: (await client.query('SELECT current_database() AS name')).rows[0].name, schema, topicIds,
      tables: Object.fromEntries(tables.map(table => [table, { count: rows[table].length, digest: hash(sorted(rows[table])) }])),
      messages: rows.messages.map(row => ({ id: row.id, digest: hash(row) })).sort((a, b) => a.id.localeCompare(b.id)),
      revisions: rows.revisions.map(row => ({ id: `${row.messageId}:${row.revision}`, digest: hash(row) })).sort((a, b) => a.id.localeCompare(b.id)),
      changes: changes.map(row => ({ sequence: Number(row.sequence), digest: hash(row) })),
      memberships: rows.memberships, actions: rows.membership_actions, settings: rows.settings,
      replay: { accounts: accountMatch, memberships: membershipMatch, messages: messageMatch, changeCount: replay.changeCount, sequence: replay.sequence },
    };
    if (mode === 'capture') {
      if (baselinePath === '-') console.log(JSON.stringify(snapshot));
      else { writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + '\n'); console.log(JSON.stringify({ captured: true, database: snapshot.database, topics: topicIds.length, messages: messages.length, replay: snapshot.replay })); }
    }
    else {
      const before = JSON.parse(readFileSync(baselinePath === '-' ? 0 : baselinePath, 'utf8')) as typeof snapshot;
      if (before.database !== snapshot.database || before.schema !== schema) throw new Error('Baseline target mismatch');
      const ids = new Set(before.topicIds);
      const expectedRemoved = before.memberships.filter(row => ids.has(row.parentId) || ids.has(row.memberId));
      const expectedMemberships = before.memberships.filter(row => !ids.has(row.parentId) && !ids.has(row.memberId));
      const upgrade: Change = JSON.parse(changes.at(-1)!.body);
      const checks: Record<string, boolean> = {
        messageBytesUnchanged: same(before.messages, snapshot.messages), revisionBytesUnchanged: same(before.revisions, snapshot.revisions),
        historicalJournalUnchanged: same(before.changes, snapshot.changes.slice(0, before.changes.length)),
        oneAppendedUpgrade: snapshot.changes.length === before.changes.length + 1 && upgrade.upgrade?.kind === 'retire-legacy-topics',
        onlyDirectMembershipsRemoved: same(sorted(expectedMemberships), sorted(rows.memberships)),
        removalManifestMatches: same(sorted(expectedRemoved.map(({ position: _position, ...row }) => row)), sorted(upgrade.upgrade?.releasedMemberships ?? [])),
        removalEventsMatch: same(expectedRemoved.map(row => row.memberId).sort(), [...upgrade.removedMemberships].sort()),
        retiredTopicsMatch: same([...before.topicIds].sort(), [...upgrade.upgrade?.topicIds ?? []].sort()),
        originalJoinHistoryPreserved: same(sorted(before.actions.map(row => ({ ...row, disabled: ids.has(row.body.parentId) || ids.has(row.body.memberId) ? true : row.disabled }))), sorted(rows.membership_actions)),
        retirementStatesExported: before.topicIds.every(id => replay.states.find(state => state.messageId === id)?.organizationRetired === true),
        noRetiredMembershipRemaining: !memberships.some(row => ids.has(row.parentId) || ids.has(row.memberId)),
        noMoneyMovement: upgrade.ledger.length === 0,
        settingsPreserved: same(sorted(before.settings.filter(row=>row.key!=='retired-organizations')), sorted(rows.settings.filter(row => row.key !== 'retired-organizations'))),
        replayAccountsMatch: accountMatch, replayMembershipsMatch: membershipMatch, replayMessagesMatch: messageMatch,
        schemaVersionRecorded: rows.schema_migrations.some(row => row.version === 3 && row.name === 'retire-converted-topic-containers'),
        priorSchemaVersionsPreserved: hash(sorted(rows.schema_migrations.filter(row => row.version <= before.tables.schema_migrations.count))) === before.tables.schema_migrations.digest,
      };
      const allowed = new Set(['schema_migrations', 'settings', 'memberships', 'membership_actions', 'changes']);
      for (const [table, fingerprint] of Object.entries(before.tables)) if (!allowed.has(table)) checks[`unchanged:${table}`] = same(fingerprint, snapshot.tables[table]);
      const report = { verified: Object.values(checks).every(Boolean), database: snapshot.database, schema, checks,
        retiredTopics: before.topicIds.length, releasedDirectMembers: expectedRemoved.filter(row => ids.has(row.parentId)).length,
        preservedMemberships: expectedMemberships.length, deletedMessages: 0, upgradeSequence: upgrade.sequence,
        backupBaselineDigest: hash(before), replay: snapshot.replay, tables: snapshot.tables };
      if (reportPath !== '-') writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(reportPath === '-' ? report : { verified: report.verified, database: report.database, retiredTopics: report.retiredTopics,
        releasedDirectMembers: report.releasedDirectMembers, preservedMemberships: report.preservedMemberships,
        deletedMessages: 0, checks: Object.keys(checks).length, failed: Object.keys(checks).filter(key => !checks[key]), replay: report.replay }, null, 2));
      if (!report.verified) process.exitCode = 1;
    }
    await client.query('COMMIT');
  } finally { client.release(); }
} finally { await pool.end(); }
