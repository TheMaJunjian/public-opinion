import {messageReadingKey,originalReadingKey,relations,type Message,type ReadingMark,type Reference} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {readingStorageKey} from '../../server/src/reading-state.js';
import {simplifyCorrectionMessage,meaningCorrectionTarget,meaningReference} from './simplified-corrections-format.js';
import {referenceBasisKey} from '../../server/src/reference-bases.js';
import {readReference,validateReferences} from '../../server/src/validation.js';
import {chargeMessage} from '../../server/src/message-spending.js';
import {financialFingerprint} from './financial-fingerprint.js';

/** Upgrade display metadata and private progress; fixed contracts and signatures remain intact. */
export async function migrateSimplifiedCorrections(store:Store){
  const finances=await financialFingerprint(store.db),ledgerStart=store.db.ledger.length;
  await store.db.exec('CREATE TABLE IF NOT EXISTS simplified_correction_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body JSONB NOT NULL,PRIMARY KEY(table_name,row_key))');
  await store.db.exec('CREATE TABLE IF NOT EXISTS reference_bases(key TEXT PRIMARY KEY,body JSONB NOT NULL)');
  const originals=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message),converted=new Set(originals.filter(meaningCorrectionTarget).map(message=>message.id));
  const freeze=async(reference:Reference,required=false)=>{
    if(!converted.has(reference.messageId)&&!(reference.context&&'version' in reference.context&&reference.context.version?.corrections.some(item=>converted.has(item.messageId))))return;
    try{const value=await readReference(store,reference);await store.db.prepare('INSERT INTO reference_bases VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING').run(referenceBasisKey(reference),JSON.stringify({reference,value}));}
    catch(error){if(required)throw error;}
  };
  for(const message of originals)for(const part of relations(message))for(const bindings of Object.values(part.roles))for(const binding of bindings)await freeze(binding.reference);
  for(const row of await store.db.prepare('SELECT body FROM rounds').all())await freeze(JSON.parse(String(row.body)).target,true);
  for(const row of await store.db.prepare('SELECT target FROM execution_stances').all())await freeze(typeof row.target==='string'?JSON.parse(row.target):row.target,true);
  for(const row of await store.db.prepare('SELECT reference FROM stake_positions WHERE reference IS NOT NULL').all())await freeze(typeof row.reference==='string'?JSON.parse(row.reference):row.reference,true);
  const tx=new Mutation(store),rules=await store.rules();let operatingDelta=0;
  const references:Message[]=[],used=new Set(originals.map(message=>message.id));
  for(const old of originals){
    const next=simplifyCorrectionMessage(old);
    if(JSON.stringify(old)===JSON.stringify(next))continue;
    await store.db.prepare('INSERT INTO simplified_correction_backups VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING').run('messages',old.id,JSON.stringify(old));
    references.push(meaningReference(old,used));
    const refund=old.spending.protocol-rules.protocolFee;
    next.spending={...old.spending,protocol:rules.protocolFee};next.ruleVersion=rules.version;
    if(refund){await store.ledger(old.authorId,old.id,refund,0,'普通消息转换费用差额',true);await store.operating(-refund,true);operatingDelta-=refund;}
    // Convert in place. Only separately frozen reference evidence retains old content.
    await tx.put(next);
  }
  if(tx.messages.size)await tx.commit();
  for(const reference of references){
    await validateReferences(store,reference.parts);
    const publication=new Mutation(store),message=await publication.create(reference.authorId,reference.parts,{protocol:rules.protocolFee,recommendation:1,wager:0},reference.id);
    await chargeMessage(store,message,false,true);await publication.commit();operatingDelta+=rules.protocolFee+1;
  }
  const additions=store.db.ledger.slice(ledgerStart);
  if(await financialFingerprint(store.db,additions,operatingDelta)!==finances)throw new Error('费用差额和新增引用之外的历史资金发生变化，停止迁移');
  const groups=new Map<string,Array<{row:any;mark:ReadingMark}>>();
  for(const row of await store.db.prepare('SELECT "userId","messageId",scope,key,body FROM reading_marks').all()){
    const mark=row.body as ReadingMark;if(mark.format===3)continue;
    const id=JSON.stringify([row.userId,row.messageId]),items=groups.get(id)??[];items.push({row,mark});groups.set(id,items);
    await store.db.prepare('INSERT INTO simplified_correction_backups VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING').run('reading_marks',JSON.stringify([row.userId,row.messageId,row.scope,row.key]),JSON.stringify(mark));
    await store.db.prepare('DELETE FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').run(row.userId,row.messageId,row.scope,row.key);
  }
  const save=async(userId:string,mark:ReadingMark)=>store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING').run(userId,mark.messageId,mark.scope,readingStorageKey(mark),JSON.stringify(mark));
  for(const items of groups.values()){
    const userId=String(items[0]!.row.userId),messageId=String(items[0]!.row.messageId);
    const bodies=items.filter(item=>item.mark.scope!=='influence'&&!item.mark.unknownContext&&!!item.mark.version);
    bodies.sort((a,b)=>(a.mark.position??0)-(b.mark.position??0)||(a.mark.updatedAt??'').localeCompare(b.mark.updatedAt??''));
    const latest=bodies.at(-1)?.mark,first=bodies.find(item=>item.mark.state!=='UNREAD')?.mark;
    if(latest){
      const original=bodies.findLast(item=>!item.mark.version!.corrections.length&&item.mark.state!=='UNREAD')?.mark;
      if(original)await save(userId,{...original,format:3,scope:'original',key:originalReadingKey(messageId),bodySignature:originalReadingKey(messageId)});
      const key=messageReadingKey(messageId);
      // Old selection fingerprints encoded version-specific display scopes.
      // Their full evidence is archived above; do not compare them as new events.
      const {selection:historicalSelection,...shared}=latest;void historicalSelection;
      await save(userId,{...shared,format:3,scope:'message',key,bodySignature:key,state:latest.state??'READ',...(first?{firstConfirmedAt:first.updatedAt??new Date().toISOString(),baselineSequence:await store.latestSequence()} :{}),...(original?{originalSeen:true}:{})});
    }
    for(const {mark} of items){
      if(mark.scope==='influence'&&!mark.unknownContext&&mark.eventId){
        const key=mark.key.replace(/^.*:(agree:|disagree:|recommend:|archive:|attention:|block:|tag:.*|correct:.*|referenced|reference:.*|round:|round_result:|terminate_settlement:)$/,'$1');
        await save(userId,{...mark,format:3,key});
      }else if(mark.unknownContext||!mark.version&&mark.scope!=='influence')await save(userId,{...mark,format:3,unknownContext:true,key:`historical:3:${mark.key}`});
    }
  }
}
