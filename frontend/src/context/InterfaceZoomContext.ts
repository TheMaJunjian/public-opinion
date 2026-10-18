import { createContext, useContext } from 'react';

export const InterfaceZoomContext = createContext(1);

/** Layout measurements use CSS pixels before the app's visual scale is applied. */
export const useInterfaceZoom = () => useContext(InterfaceZoomContext);
