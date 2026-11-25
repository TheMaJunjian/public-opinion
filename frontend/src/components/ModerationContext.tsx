import { createContext } from 'react';
import type { ModerationSummary, ReviewContext, UserView } from '@gonglun/core';

export const reviewStatusLabel={pending:'待审核',approved:'审核通过',rejected:'审核不通过',appeal:'复核中',unknown:'审核未定'};
export type ArbitrationType='TRUTH'|'VALUE'|'REVIEW';
export const MessageViewerContext=createContext<Pick<UserView,'id'|'username'>|null>(null);
export const CoveredBodyContext=createContext<((messageId:string)=>void)|null>(null);
interface ReviewStatistics {
  summaries:ReadonlyMap<string,ModerationSummary>;
  sourcesFor?:(id:string)=>readonly ModerationSummary[]|undefined;
}
export const LocalReviewRecordsContext=createContext<Partial<ReviewStatistics>&{
  available:ReadonlySet<string>;
  open:(id:string,revision:number)=>void;
}|null>(null);
export const ModerationContext=createContext<ReviewStatistics&{
  subjectLabel?:(id:string)=>string|undefined;
  open:(id:string,revision?:number)=>void;
  arbitrate:(cardId:string,target?:ReviewContext)=>void;
  onSettled?:(summary:ModerationSummary)=>void;
  activeId?:string;
  activeTarget?:ReviewContext;
}|null>(null);
