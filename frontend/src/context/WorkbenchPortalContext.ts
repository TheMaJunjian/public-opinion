import { createContext, useContext } from 'react';

export const WorkbenchPortalContext = createContext<HTMLElement | null>(null);
/** Cached views keep their floating windows in the same retained lifetime. */
export const useWorkbenchPortalTarget = () => useContext(WorkbenchPortalContext) ?? document.body;
