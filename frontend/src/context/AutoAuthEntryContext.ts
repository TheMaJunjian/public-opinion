import { createContext } from 'react';

/** Only the automatic entry prompt yields to dialogs the visitor already opened. */
export const AutoAuthEntryContext = createContext<{ suspended: boolean } | null>(null);
