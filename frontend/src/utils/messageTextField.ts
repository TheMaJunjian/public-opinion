import type { Part, Reference } from '@gonglun/core';
import type { DemoMessage } from './modelBridge';

const readableText = (part: Part) => part.type === 'text' ? part.text
  : part.type === 'code' ? part.source : part.type === 'web' ? part.excerpt || part.url : undefined;

/** Resolve the text actually shown on a card without assigning generated labels to its body. */
export function messageTextField(message: DemoMessage, displayedText?: string): { part: Part; path?: Reference['path'] } | undefined {
  const part = message.parts?.find(candidate => {
    const text = readableText(candidate);
    return text !== undefined && (displayedText === undefined || text === displayedText);
  });
  if (part) return { part };
  // Imported organizations can keep their name in data.title while body contains
  // an old, generated relation description. Keep the original field address.
  if (displayedText !== undefined && ['classify', 'summary', 'merge', 'arrange'].includes(message.relationType ?? '')) {
    const titlePart = [...(message.parts ?? [])].reverse().find(candidate => candidate.type === 'data'
      && candidate.value && typeof candidate.value === 'object' && !Array.isArray(candidate.value)
      && candidate.value.title === displayedText);
    if (titlePart) return { part: titlePart, path: ['value', 'title'] };
  }
  return undefined;
}
