import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../apps/server/src/db.js';
import { viewsFor, stakesFor, allUsers } from '../apps/server/src/ui-projections.js';
import { isRelationView, type Message, type WorkbenchSnapshot } from '@gonglun/core';
import { projectWorkbenchSnapshot } from '../frontend/src/utils/workbenchProjection.js';
import { deriveContainerEffect } from '../frontend/src/pages/workbench/model/containerEffect.js';
import { projectContainerCanvas } from '../frontend/src/pages/workbench/projections/containerCanvas.js';

const [mode, baselinePath, reportPath] = process.argv.slice(2);
if (!['capture', 'verify'].includes(mode) || !baselinePath || mode === 'verify' && !reportPath) throw new Error('capture BASELINE | verify BASELINE REPORT');
const current = await Store.inspect(process.env.DATABASE_URL!, { schema: process.env.DATABASE_SCHEMA }, async (store): Promise<WorkbenchSnapshot> => {
    const messages = (await store.db.prepare('SELECT body FROM messages ORDER BY "createdAt",id').all()).map(row => JSON.parse(row.body) as Message);
    const users = await allUsers(store), views = await viewsFor(store, messages, 'root', users);
    return { scope: { messageId: null, title: '公论' }, messages: views, relations: views.filter(isRelationView), users,
      stakes: await stakesFor(store, messages.map(message => message.id), users), tagCounts: {}, attentionUsers: {}, sequence: await store.latestSequence() };
});
  if (mode === 'capture') {
    if (baselinePath === '-') console.log(JSON.stringify(current));
    else { writeFileSync(baselinePath, JSON.stringify(current)); console.log(JSON.stringify({ captured: true, messages: current.messages.length, users: current.users.length })); }
  }
  else {
    const before = JSON.parse(readFileSync(baselinePath === '-' ? 0 : baselinePath, 'utf8')) as WorkbenchSnapshot;
    const retired = new Set(current.messages.filter(message => message.state?.organizationRetired).map(message => message.id));
    const containers = before.relations.filter(relation => ['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE'].includes(relation.relationType) && !retired.has(relation.id)).map(relation => relation.id);
    const a = projectWorkbenchSnapshot(before), b = projectWorkbenchSnapshot(current);
    const diffs: unknown[] = [], sorted = (ids: Iterable<string>) => [...ids].filter(id => !retired.has(id)).sort().join(',');
    for (const username of [null, ...before.users.map(user => user.username)]) {
      const first = deriveContainerEffect({ ...a, username, stakeCounts: a.counts });
      const last = deriveContainerEffect({ ...b, username, stakeCounts: b.counts });
      for (const id of containers) {
        const old = first.ownership.direct(id), next = last.ownership.direct(id);
        if (sorted(old.textIds) !== sorted(next.textIds) || sorted(old.relationIds) !== sorted(next.relationIds))
          diffs.push({ username, containerId: id, before: { text: sorted(old.textIds), relations: sorted(old.relationIds) }, after: { text: sorted(next.textIds), relations: sorted(next.relationIds) } });
      }
      const root = projectContainerCanvas(last, { kind: 'root' });
      if (root.messages.some(message => retired.has(message.id))) diffs.push({ username, retiredTopicVisible: true });
      if ([...retired].some(id => last.ownership.direct(id).textIds.size || last.ownership.direct(id).relationIds.size)) diffs.push({ username, retiredTopicOwnsMembers: true });
    }
    const report = { verified: diffs.length === 0, viewers: before.users.length + 1, ordinaryContainers: containers.length,
      retiredTopics: retired.size, retainedMessages: current.messages.length, diffs };
    if (reportPath !== '-') writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(reportPath === '-' ? report : { ...report, diffs: diffs.slice(0, 3) }));
    if (!report.verified) process.exitCode = 1;
  }
