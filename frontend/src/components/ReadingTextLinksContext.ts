import { createContext, useContext } from 'react';
import type { ReadingTextLinkHint } from './ReadingTextLinks';

export type ReadingTextLinksSetting = boolean | {
  linksForMessage: (messageId: string) => readonly ReadingTextLinkHint[];
};

/** Presentation only; enabled by the local Zhihu document reader. */
export const ReadingTextLinksContext = createContext<ReadingTextLinksSetting>(false);

export function useReadingTextLinks(messageId: string) {
  const setting = useContext(ReadingTextLinksContext);
  return { enabled: !!setting, hints: typeof setting === 'object' ? setting.linksForMessage(messageId) : undefined };
}
