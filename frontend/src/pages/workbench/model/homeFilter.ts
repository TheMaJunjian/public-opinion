export type HomeFilterSelection={scope:'all'|'self'|'related'|'following';status:'all'|'pending'|'confirmed'};
/** Keep old saved views readable; new selections use two independent axes. */
export type HomeFilterMode=HomeFilterSelection|'read-self'|'read-related'|'unread-related'|'unread-other';
export function normalizeHomeFilter(mode:HomeFilterMode|null):HomeFilterSelection {
  if(!mode)return {scope:'all',status:'all'};
  if(typeof mode==='object')return mode;
  return mode==='read-self'?{scope:'self',status:'all'}:mode==='read-related'?{scope:'related',status:'confirmed'}
    :mode==='unread-related'?{scope:'related',status:'pending'}:{scope:'all',status:'pending'};
}
export function isHomeFilterMode(value:unknown):value is HomeFilterMode|null {
  if(value===null||['read-self','read-related','unread-related','unread-other'].includes(String(value)))return true;
  if(!value||typeof value!=='object')return false;
  const item=value as HomeFilterSelection;
  return ['all','self','related','following'].includes(item.scope)&&['all','pending','confirmed'].includes(item.status);
}
