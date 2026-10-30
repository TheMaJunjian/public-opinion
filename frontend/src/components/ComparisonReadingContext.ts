import {createContext} from 'react';
import type {ReadingMark} from '@gonglun/core';

export const ComparisonReadingContext=createContext<{marks:readonly ReadingMark[];basisFor:(messageId:string)=>string;onMarkRead?:(marks:ReadingMark[])=>Promise<void>}|null>(null);
