import type { DemoEdge, DemoMessage } from './modelBridge';
import { getPresentationSpec } from '../types';

type DisplayGroups = ReadonlyMap<string, ReadonlySet<string>>;
const canvasGroups = new WeakMap<HTMLElement, DisplayGroups>();

/** Messages that share a display anchor, plus the members of organization frames. */
export function createMessageJumpGroups(messages: DemoMessage[], edges: DemoEdge[], frames: DisplayGroups): DisplayGroups {
  const groups = new Map([...frames].map(([id, members]) => [id, new Set(members)]));
  const include = (owner: string | null | undefined, id: string) => {
    if (!owner || owner === id || owner.startsWith('anon:')) return;
    const members = groups.get(owner) ?? new Set<string>();
    members.add(id); groups.set(owner, members);
  };
  for (const message of messages) {
    if (message.joinInfo) include(message.joinInfo.containerId, message.id);
    if (['annotation', 'reference', 'reply', 'correct'].includes(message.relationType ?? '')) include(message.sourceMessageId, message.id);
  }
  for (const edge of edges) {
    if (['annotation', 'reference', 'reply', 'correct'].includes(edge.relationType)) include(edge.from.messageId, edge.relationMessageId);
    else if (['agree', 'disagree', 'tag'].includes(edge.relationType) || getPresentationSpec(edge.relationType).kind === 'inline-badge') {
      include(edge.to.messageId, edge.relationMessageId);
    }
    if (edge.relationType === 'correct') include(edge.to.messageId, edge.relationMessageId);
  }
  return groups;
}

export function registerMessageJumpGroups(canvas: HTMLElement, groups: DisplayGroups): () => void {
  canvasGroups.set(canvas, groups);
  return () => { if (canvasGroups.get(canvas) === groups) canvasGroups.delete(canvas); };
}

export function getMessageJumpDisplay(target: HTMLElement, messageId: string, fallback = target.getBoundingClientRect()) {
  const canvas = target.closest<HTMLElement>('[data-jump-canvas]');
  if (!canvas) return { source: target, elements: undefined, rect: fallback };
  const groups = canvasGroups.get(canvas);
  // An edge record is inspected through its compact label. Its entire SVG
  // curve can span the canvas and must remain under the navigation mask.
  const labels=Array.from(canvas.querySelectorAll('[data-directed-edge-label]'))
    .filter(element=>element.getAttribute('data-directed-edge-label')===messageId);
  if(target.hasAttribute('data-directed-edge-start'))return {source:canvas,elements:new Set<Element>([target,...labels]),rect:target.getBoundingClientRect()};
  if(labels.length){
    const elements=new Set<Element>(labels),first=labels[0].getBoundingClientRect();
    const rect=labels.slice(1).reduce((bounds,element)=>{const next=element.getBoundingClientRect();
      const left=Math.min(bounds.left,next.left),top=Math.min(bounds.top,next.top);
      return new DOMRect(left,top,Math.max(bounds.right,next.right)-left,Math.max(bounds.bottom,next.bottom)-top);
    },first);
    return {source:canvas,elements,rect};
  }
  const ids = new Set([messageId]);
  // A Set breaks cycles and also visits newly added nested members/dependants.
  for (const id of ids) for (const member of groups?.get(id) ?? []) ids.add(member);
  const elements = new Set<Element>([target]);
  for (const element of canvas.querySelectorAll('[data-msgid], [data-jump-msgids], [data-jump-visual-msgids]')) {
    const names = [element.getAttribute('data-msgid'), element.getAttribute('data-jump-msgids'), element.getAttribute('data-jump-visual-msgids')];
    if (names.some(value => value?.split(/\s+/).some(id => ids.has(id)))) elements.add(element);
  }
  const rect = [...elements].reduce((bounds, element) => {
    const next = element.getBoundingClientRect();
    if (next.width <= 0 || next.height <= 0) return bounds;
    const left = Math.min(bounds.left, next.left), top = Math.min(bounds.top, next.top);
    return new DOMRect(left, top, Math.max(bounds.right, next.right) - left, Math.max(bounds.bottom, next.bottom) - top);
  }, fallback);
  return { source: canvas, elements: groups ? elements : undefined, rect };
}

/** Screen-space openings in the prompt layer, clipped exactly like the live scene. */
export function getMessageJumpRegions(target: HTMLElement, messageId: string, fallback = target.getBoundingClientRect()) {
  const display = getMessageJumpDisplay(target, messageId, fallback);
  const elements = display.elements ?? new Set([target]);
  const regions: Array<{ rect: DOMRect; ids: string }> = [];
  for (const element of elements) {
    const bounds = display.elements ? element.getBoundingClientRect() : display.rect;
    let { left, top, right, bottom } = bounds;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (!clip.width || !clip.height) continue;
      if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) {
        left = Math.max(left, clip.left); right = Math.min(right, clip.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) {
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
    }
    if (right <= left || bottom <= top) continue;
    const ids = [element.getAttribute('data-msgid'), element.getAttribute('data-jump-msgids'), element.getAttribute('data-jump-visual-msgids')]
      .filter(Boolean).join(' ') || messageId;
    regions.push({ rect: new DOMRect(left, top, right - left, bottom - top), ids });
  }
  return regions;
}
