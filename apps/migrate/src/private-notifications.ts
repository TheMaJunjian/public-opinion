import { textOf, type Message, type NotificationContent } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';
import { notificationSchema } from '../../server/src/notification-schema.js';

/** Only explicit historical receipts prove delivery. Do not infer past followers. */
export async function migratePrivateNotifications(store: Store) {
  await store.db.exec(notificationSchema);
  const rows = await store.db.prepare(`SELECT n."userId",n."targetId",m.body,u.name
    FROM notification_receipts n JOIN messages m ON m.id=n."sourceId"
    JOIN users recipient ON recipient.id=n."userId" LEFT JOIN users u ON u.id=m."authorId"
    WHERE n."userId"<>m."authorId" ORDER BY m.sequence,m.id,n."userId",n."targetId"`)
    .all<{userId:string;targetId:string;body:string;name:string|null}>();
  const seenAt = new Date().toISOString();
  for (const row of rows) {
    const message = JSON.parse(row.body) as Message;
    const target = await store.db.prepare('SELECT body FROM messages WHERE id=$1').get<{body:string}>(row.targetId);
    const body: NotificationContent = {
      actorName:row.name ?? '公论规则', action:'邀请你查看', excerpt:textOf(message).replace(/\s+/g,' ').slice(0,180),
      targetExcerpt:target ? textOf(JSON.parse(target.body)).replace(/\s+/g,' ').slice(0,180) : '', sourceRevision:message.revision,
      references:[{messageId:row.targetId}], reasons:['历史明确通知'], watchedIds:[],
    };
    const eventId = JSON.stringify([message.id,message.revision]);
    await store.db.prepare(`INSERT INTO notifications("userId","eventId","sourceId","targetId","actorId",category,kind,"groupKey","createdAt","changeSequence",body,"seenAt")
      VALUES($1,$2,$3,$4,$5,'direct','notify',$2,$6,$7,$8::jsonb,$9) ON CONFLICT("userId","eventId") DO NOTHING`)
      .run(row.userId,eventId,message.id,row.targetId,message.authorId,message.createdAt,message.sequence,JSON.stringify(body),seenAt);
  }
  await store.db.prepare("INSERT INTO settings(key,value) VALUES('notifications-start-sequence',$1) ON CONFLICT(key) DO NOTHING")
    .run(JSON.stringify(await store.latestSequence()));
}
