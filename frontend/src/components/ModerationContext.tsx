import { createContext } from 'react';
import type { ModerationSummary } from '@gonglun/core';

export const reviewStatusLabel={pending:'待审核',approved:'审核通过',rejected:'审核不通过',appeal:'复核中',unknown:'审核未定'};
export type ArbitrationType='TRUTH'|'VALUE'|'REVIEW';
export const ModerationContext=createContext<{
  summaries:ReadonlyMap<string,ModerationSummary>;
  open:(id:string)=>void;
  arbitrate:(id:string)=>void;
  activeId?:string;
}|null>(null);
