import type { Change, MembershipAction, Message } from '@gonglun/core';
import type { Store } from './db.js';

export interface MembershipNotification {
  message:Message;
  memberId:string;
  parentId:string;
  active:boolean;
  previousActive?:boolean;
}

/** Compare effective placements, not votes: rejection, displacement and restoration share one rule. */
export async function membershipNotifications(store:Store,change:Change):Promise<MembershipNotification[]> {
  const states=change.states.filter(state=>state.membershipActive!==undefined);
  if(!states.length||!await store.db.prepare("SELECT 1 FROM settings WHERE key='notification-membership-start-sequence'").get())return [];
  const rows=await store.db.prepare(`SELECT a.id,a.body,m.body AS message,s.active,s.sequence FROM membership_actions a
    JOIN messages m ON m.id=a.id LEFT JOIN notification_membership_states s ON s."messageId"=a.id
    WHERE a.id=ANY($1::text[])`).all<{id:string;body:MembershipAction;message:string;active:boolean|null;sequence:number|null}>(states.map(state=>state.messageId));
  const byId=new Map(rows.map(row=>[row.id,row])),events:MembershipNotification[]=[];
  const updates:Array<{messageId:string;active:boolean;sequence:number}>=[];
  for(const state of states){
    const row=byId.get(state.messageId);if(!row||row.sequence!==null&&row.sequence>=change.sequence)continue;
    const isNew=change.messages.some(message=>message.id===row.id&&message.revision===1);
    if(row.active===null?isNew:row.active!==state.membershipActive)events.push({message:JSON.parse(row.message),
      memberId:row.body.memberId,parentId:row.body.parentId,active:state.membershipActive!,previousActive:row.active??undefined});
    updates.push({messageId:row.id,active:state.membershipActive!,sequence:change.sequence});
  }
  if(updates.length)await store.db.prepare(`INSERT INTO notification_membership_states("messageId",active,sequence)
    SELECT "messageId",active,sequence FROM jsonb_to_recordset($1::jsonb) AS state("messageId" text,active boolean,sequence bigint)
    ON CONFLICT("messageId") DO UPDATE SET active=excluded.active,sequence=excluded.sequence
    WHERE notification_membership_states.sequence<excluded.sequence`).run(JSON.stringify(updates));
  return events;
}
