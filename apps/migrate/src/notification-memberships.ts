import type { Store } from '../../server/src/db.js';
import {notificationMembershipSchema} from '../../server/src/notification-schema.js';

export async function migrateNotificationMemberships(store:Store) {
  await store.db.exec(notificationMembershipSchema);
  const sequence=await store.latestSequence();
  await store.db.prepare(`INSERT INTO notification_membership_states("messageId",active,sequence)
    SELECT a.id,EXISTS(SELECT 1 FROM memberships m WHERE m."sourceId"=a.id),$1 FROM membership_actions a
    ON CONFLICT("messageId") DO NOTHING`).run(sequence);
  await store.db.prepare("INSERT INTO settings(key,value) VALUES('notification-membership-start-sequence',$1) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(sequence));
}
