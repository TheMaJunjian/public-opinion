import { lazy } from 'react';

// Status explanations load with the views that display them, while explicit
// READ commands keep their small snapshot helpers available synchronously.
export const MessageDisplayHintsProvider = lazy(() => import('./MessageDisplayHints')
  .then(module => ({ default: module.MessageDisplayHintsProvider })));
export const MessageDisplayMarker = lazy(() => import('./MessageDisplayHints')
  .then(module => ({ default: module.MessageDisplayMarker })));
