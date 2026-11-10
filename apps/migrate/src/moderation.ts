import { bindRoles, DEFAULT_MODERATION_POLICY, type Message, type Reference } from '@gonglun/core';
import { Mutation, now, type Store } from '../../server/src/db.js';
import { moderationSchema } from '../../server/src/moderation-schema.js';
import { enrollModeration } from '../../server/src/moderation.js';
import { indexModerationDependencies } from '../../server/src/moderation-visibility.js';
import { reconcileOrganizationEffects } from '../../server/src/organizations.js';

/** The migration is atomic and versioned. Existing content is charged once, including funded debt. */
export async function migrateModeration(store:Store){
  await store.db.exec(moderationSchema);
  const rules=await store.rules();
  if(!rules.moderation){
    const next={...rules,version:rules.version+1,moderation:{...DEFAULT_MODERATION_POLICY}};await store.set('rules',next);
    await store.db.prepare('INSERT INTO rule_versions(version,body,"authorizationId","createdAt") VALUES($1,$2,NULL,$3)').run(next.version,JSON.stringify(next),now());
  }else await store.set('rules',{...rules,moderation:{...DEFAULT_MODERATION_POLICY,...rules.moderation}});
  await store.db.prepare("INSERT INTO settings VALUES('moderation-fund','0') ON CONFLICT DO NOTHING").run();
  const end=await store.latestSequence();let sequence=-1,cursor='';
  for(;;){
    const rows=await store.db.prepare('SELECT body FROM messages WHERE sequence<=$1 AND (sequence,id)>($2,$3) ORDER BY sequence,id LIMIT 100').all<{body:string}>(end,sequence,cursor);
    if(!rows.length)break;
    const tx=new Mutation(store),enrolled:Reference[]=[];
    for(const row of rows){const message=JSON.parse(row.body) as Message;
      for(const revision of await store.db.prepare('SELECT body FROM revisions WHERE "messageId"=$1').all<{body:string}>(message.id))await indexModerationDependencies(store,JSON.parse(revision.body));
      const review=await enrollModeration(tx,message,true);
      if(review)enrolled.push({messageId:message.id,revision:message.revision});
      sequence=message.sequence;cursor=message.id;}
    if(enrolled.length){
      await tx.create('system',[
        {id:'body',type:'text',text:'历史内容纳入审核：审核费与自押分别冻结，余额不足记入欠额。'},
        {id:'record',type:'relation',relation:'review-enrollment',roles:bindRoles({target:enrolled})},
        {id:'data',type:'data',value:{migration:'content-moderation',messageIds:enrolled.map(reference=>reference.messageId)}},
      ]);
      await reconcileOrganizationEffects(tx);await tx.commit();
    }
  }
}
