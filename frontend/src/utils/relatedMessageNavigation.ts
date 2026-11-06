/** Open the record represented by a summary without revealing or moving its canvas edge. */
export const LOCATE_RELATED_MESSAGE = 'workbench:locate-related-message';
export interface RelatedMessageLocation {
  messageId: string;
  handled?: boolean;
  onLocated: (element: HTMLElement | null) => void;
}
