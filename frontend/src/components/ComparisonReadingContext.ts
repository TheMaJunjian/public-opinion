import {createContext} from 'react';
import type {BodyVersion,ReadingMark} from '@gonglun/core';

export const ComparisonReadingContext=createContext<{marks:readonly ReadingMark[];basisFor:(messageId:string)=>string;
  influencesFor:(version:BodyVersion)=>ReadingMark[];onMarkRead?:(marks:ReadingMark[])=>Promise<void>}|null>(null);
