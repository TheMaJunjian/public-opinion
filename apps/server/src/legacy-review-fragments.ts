import { referenceVersion, type Part, type Reference } from '@gonglun/core';
import type { Store } from './db.js';

type Lookup={messageId:string;revision:number|null;partId:string};
type Destination={reasonId:string;reasonRevision:number;sameBody:boolean};
const lookupKey=(address:Lookup)=>JSON.stringify([address.messageId,address.revision,address.partId]);

/** Resolve old fragment addresses in bulk, without changing signed history. */
export async function rebindLegacyReviewFragments<T extends {parts:Part[]}>(store:Store,messages:T[]):Promise<T[]>{
  const addresses=new Map<string,Lookup>(),keys=new Map<Reference,string>(),wholeBody=new Set<Reference>();
  function collect(ref:Reference,correction=false){
    if(!ref.partId||ref.memberId)return;
    const version=referenceVersion(ref.context);
    if(version&&(version.messageId!==ref.messageId||ref.revision!==undefined&&version.revision!==ref.revision))return;
    const address={messageId:ref.messageId,revision:ref.revision??version?.revision??null,partId:ref.partId};
    const key=lookupKey(address);
    addresses.set(key,address);keys.set(ref,key);
    if(correction||version?.corrections.length)wholeBody.add(ref);
  }
  for(const message of messages)for(const part of message.parts){
    if(part.type==='relation')for(const [role,bindings] of Object.entries(part.roles))
      for(const binding of bindings)collect(binding.reference,role==='target'&&['correct','amend'].includes(part.relation));
    if(part.type==='display'&&part.target)collect(part.target);
  }
  if(!addresses.size||!(await store.db.prepare("SELECT to_regclass('legacy_review_reason_versions') AS present").get())?.present)return messages;
  // An old correction can contain a complete before/after snapshot. Its base
  // must stay with the decision when part of that snapshot moved to a separate citation.
  const bodyPath=`'$.parts[*] ? (@.type == "text" || @.type == "web" || @.type == "code")'`;
  const rows=await store.db.prepare(`SELECT i.*, h."reasonId",h."reasonRevision",
      jsonb_path_query_array(d.body::jsonb,${bodyPath})=jsonb_path_query_array(reason.body::jsonb,${bodyPath}) AS "sameBody"
    FROM jsonb_to_recordset($1::jsonb) i("messageId" text,revision integer,"partId" text)
    JOIN legacy_review_reason_versions h ON h."decisionId"=i."messageId"
    JOIN revisions d ON (d."messageId",d.revision)=(h."decisionId",h."decisionRevision")
    JOIN revisions reason ON (reason."messageId",reason.revision)=(h."reasonId",h."reasonRevision")
    WHERE h."decisionRevision"=COALESCE(i.revision,(SELECT (m.body::jsonb->>'revision')::integer FROM messages m WHERE m.id=i."messageId"))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.body::jsonb->'parts') p
        WHERE p->>'id'=i."partId" AND p->>'type' IN ('text','code','web')
          AND reason.body::jsonb->'parts' @> jsonb_build_array(p))`)
    .all<Lookup&Destination>(JSON.stringify([...addresses.values()]));
  if(!rows.length)return messages;
  const matches=new Map(rows.map(row=>[lookupKey(row),row]));
  function resolve(ref:Reference):Reference{
    const key=keys.get(ref),match=key&&matches.get(key);
    if(!match||wholeBody.has(ref)&&!match.sameBody)return ref;
    const address={messageId:match.reasonId,revision:match.reasonRevision};
    const context=ref.context;
    return {...ref,...address,...(context&&'version' in context&&context.version
      ?{context:{...context,version:{...context.version,...address}}}:{})};
  }
  return messages.map(message=>({...message,parts:message.parts.map(part=>{
    if(part.type==='display'&&part.target)return {...part,target:resolve(part.target)};
    if(part.type!=='relation')return part;
    return {...part,roles:Object.fromEntries(Object.entries(part.roles).map(([role,bindings])=>
      [role,bindings.map(binding=>({...binding,reference:resolve(binding.reference)}))]))};
  })}));
}
