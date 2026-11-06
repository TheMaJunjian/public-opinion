import type {Message} from '@gonglun/core';
import type {Store} from './db.js';

/** New publications lock value separately; maintenance retains historical operating charges. */
export async function chargeMessage(store:Store,message:Message,valueWager=false,allowDebt=false):Promise<void>{
  await store.ledger(message.authorId,message.id,-message.spending.protocol,0,'协议费',allowDebt);
  await store.operating(message.spending.protocol,true);
  if(message.spending.recommendation&&!valueWager){
    await store.ledger(message.authorId,message.id,-message.spending.recommendation,0,'价值投入',allowDebt);
    await store.operating(message.spending.recommendation,true);
  }
}
