import { lazy } from 'react';

// Viewing controls load with the message views that display them.
export const MessageDisplayHintsProvider = lazy(() => import('./MessageDisplayHints')
  .then(module => ({ default: module.MessageDisplayHintsProvider })));
export const MessageDisplayMarker = lazy(() => import('./MessageDisplayHints')
  .then(module => ({ default: module.MessageDisplayMarker })));
