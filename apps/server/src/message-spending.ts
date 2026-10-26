import type {Message} from '@gonglun/core';
import type {Store} from './db.js';

/** Every published message pays its own fee and value investment in the same transaction. */
export async function chargeMessage(store:Store,message:Message,targetValueWager=false,allowDebt=false):Promise<void>{
  await store.ledger(message.authorId,message.id,-message.spending.protocol,0,'协议费',allowDebt);
  await store.operating(message.spending.protocol,true);
  if(message.spending.recommendation&&!targetValueWager){
    await store.ledger(message.authorId,message.id,-message.spending.recommendation,0,'价值投入',allowDebt);
    await store.operating(message.spending.recommendation,true);
  }
}
