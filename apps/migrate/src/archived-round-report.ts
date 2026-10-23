import type {Store} from '../../server/src/db.js';
import {userView,type RecordData} from '../../server/src/ui-projections.js';
export async function archivedRoundReport(store:Store,id:string,round:RecordData,authorId:string):Promise<RecordData> {
const votes=round.legacyVotes??[];
        const stakes=await store.db.prepare('SELECT side,amount,"roundId" FROM legacy_stakes WHERE "messageId"=$1 AND "settlementType"=$2 ORDER BY "createdAt",id').all(round.subjectId,round.settlementType);
        const weight=(side:string,onlyRound=false)=>stakes.filter(row=>row.side===side&&(!onlyRound||row.roundId===id)).reduce((sum,row)=>sum+Number(row.amount),0);
        const sum=(vote:string)=>votes.filter((row:RecordData)=>row.vote===vote).reduce((total:number,row:RecordData)=>total+row.amount,0)+(vote==='TRUE'?weight('PRO'):vote==='FALSE'?weight('CON'):0);
        const pool=await store.db.prepare('SELECT "lockedPro","lockedCon" FROM legacy_pools WHERE "messageId"=$1 AND "settlementType"=$2').get(round.subjectId,round.settlementType);
        const roundWeights={TRUE:weight('PRO',true)+votes.filter((row:RecordData)=>row.vote==='TRUE').reduce((total:number,row:RecordData)=>total+row.amount,0),FALSE:weight('CON',true)+votes.filter((row:RecordData)=>row.vote==='FALSE').reduce((total:number,row:RecordData)=>total+row.amount,0),UNKNOWN:votes.filter((row:RecordData)=>row.vote==='UNKNOWN').reduce((total:number,row:RecordData)=>total+row.amount,0)};
        return {id,roundMessageId:id,messageId:round.subjectId,reference:round.target,createdByUserId:authorId,createdBy:await userView(store,authorId),status:round.legacyStatus,settlementType:round.settlementType,result:round.result==='pro'?'TRUE':round.result==='con'?'FALSE':round.result==='tie'?'UNKNOWN':null,previousRoundId:round.previousRoundId,openedAt:round.createdAt,closedAt:round.endsAt,note:round.legacyNote,settlementPro:round.pro,settlementCon:round.con,totalProAtSettlement:round.pro,totalConAtSettlement:round.con,weights:{TRUE:sum('TRUE'),FALSE:sum('FALSE'),UNKNOWN:sum('UNKNOWN')},roundWeights,pool:pool??null,totalWeight:sum('TRUE')+sum('FALSE')+sum('UNKNOWN'),votes:await Promise.all(votes.map(async(vote:RecordData)=>({id:vote.id,vote:vote.vote,amount:vote.amount,createdAt:vote.createdAt,user:await userView(store,vote.userId)}))),_count:{votes:votes.length},legacyHistory:true};

}
