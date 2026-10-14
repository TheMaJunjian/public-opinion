import type { Change, Membership, Message, MessageState, Page, User } from '@gonglun/core';
import type { PersonalMark, PersonalPage, Query } from './api';
import { inQueryScope } from './api';

export const PAGE_LIMIT = 300;
export interface Feed { query: Query; ids: string[]; cursor: string | null; generation: number; loading: boolean; error: string | null }
export interface Store {
  messages: Record<string, Message>; users: Record<string, User>; memberships: Record<string, Membership>;
  membershipSequences: Record<string, number>;
  states: Record<string, MessageState>; stateSequences: Record<string, number>;
  feeds: Record<string, Feed>; sequence: number; initialized: boolean;
  activeKey?: string;
  personalViewer?: string; personalStates: Record<string, PersonalMark>; personalSequences: Record<string, number>;
}
export const emptyStore: Store = { messages: {}, users: {}, memberships: {}, membershipSequences: {}, states: {}, stateSequences: {}, feeds: {}, sequence: 0, initialized: false, personalStates: {}, personalSequences: {} };
export type Action =
  | { type: 'focus'; key: string }
  | { type: 'users'; users: User[] }
  | { type: 'viewer'; id?: string }
  | { type: 'personal'; viewer: string; page: PersonalPage }
  | { type: 'notifications'; viewer: string; key: string; page: PersonalPage }
  | { type: 'begin'; key: string; query: Query; generation: number }
  | { type: 'page'; key: string; generation: number; page: PersonalPage; append: boolean }
  | { type: 'error'; key: string; generation: number; error: string }
  | { type: 'context'; page: Page }
  | { type: 'change' | 'ack'; change: Change };

function mergeEntities(current: Record<string, Message>, incoming: Message[]): Record<string, Message> {
  const result = { ...current };
  for (const message of incoming) {
    const old = result[message.id];
    if (!old || message.revision > old.revision || (message.revision === old.revision && message.sequence >= old.sequence)) result[message.id] = message;
  }
  return result;
}
function matches(message: Message, query: Query, memberships: Record<string, Membership>, personalStates: Record<string, PersonalMark>): boolean {
  if (!inQueryScope(query, memberships[message.id]?.parentId)) return false;
  const mark = personalStates[message.id];
  if (query.personal === 'normal' && mark?.blocked) return false;
  if (query.personal === 'follow' && !mark?.followed) return false;
  if (query.personal === 'read' && !mark?.read) return false;
  if (query.personal === 'unread' && mark?.read) return false;
  if (query.personal === 'block' && !mark?.blocked) return false;
  if (query.personal === 'archive' && !mark?.archived) return false;
  if (query.author && message.authorId !== query.author) return false;
  if (query.relation && !message.parts.some(part => part.type === 'relation' && part.relation === query.relation)) return false;
  if (query.q) {
    const value = message.parts.map(part => part.type === 'text' ? part.text : part.type === 'web' ? part.excerpt : part.type === 'code' ? part.source : '').join(' ');
    if (!value.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) return false;
  }
  return true;
}
function mergeStates(state: Store, incoming: MessageState[], sequence: number) {
  const states = { ...state.states }; const stateSequences = { ...state.stateSequences };
  for (const value of incoming) if (sequence >= (stateSequences[value.messageId] ?? 0)) { states[value.messageId] = value; stateSequences[value.messageId] = sequence; }
  return { states, stateSequences };
}
function mergePersonal(state: Store, page: PersonalPage) {
  const personalStates = { ...state.personalStates }; const personalSequences = { ...state.personalSequences };
  for (const mark of page.personalStates || []) if (page.sequence >= (personalSequences[mark.messageId] ?? 0)) { personalStates[mark.messageId] = mark; personalSequences[mark.messageId] = page.sequence; }
  return { personalStates, personalSequences };
}

export function reducer(state: Store, action: Action): Store {
  if (action.type === 'focus') return { ...state, activeKey: action.key };
  if (action.type === 'users') return { ...state, users: { ...state.users, ...Object.fromEntries(action.users.map(user => [user.id, user])) } };
  if (action.type === 'viewer') return action.id === state.personalViewer ? state : { ...state, personalViewer: action.id, personalStates: {}, personalSequences: {} };
  if (action.type === 'personal' || action.type === 'notifications') {
    if (action.viewer !== state.personalViewer) return state;
    const next = reducer(state, { type: 'context', page: action.page });
    Object.assign(next, mergePersonal(next, action.page));
    next.feeds = { ...next.feeds };
    for (const [key, feed] of Object.entries(next.feeds)) {
      if (feed.query.viewer !== action.viewer) continue;
      if (feed.query.personal === 'notifications') {
        const incoming = action.type === 'notifications' && key === action.key ? action.page.messages.map(message => message.id) : [];
        next.feeds[key] = { ...feed, ids: [...new Set([...incoming, ...feed.ids])].filter(id => !next.personalStates[id]?.blocked).slice(0, PAGE_LIMIT) };
        continue;
      }
      const touched = new Set(action.page.personalStates?.map(mark => mark.messageId));
      const ids = feed.ids.filter(id => !touched.has(id) || (next.messages[id] && matches(next.messages[id], feed.query, next.memberships, next.personalStates)));
      for (const id of touched) if (next.messages[id] && matches(next.messages[id], feed.query, next.memberships, next.personalStates) && !ids.includes(id)) ids.unshift(id);
      next.feeds[key] = { ...feed, ids: ids.slice(0, PAGE_LIMIT) };
    }
    return trimStore(next);
  }
  if (action.type === 'begin') {
    const previous = state.feeds[action.key];
    const feeds = { ...state.feeds, [action.key]: { query: action.query, ids: previous?.ids || [], cursor: previous?.cursor || null, generation: action.generation, loading: true, error: null } };
    const keys = Object.keys(feeds);
    if (keys.length > 8) delete feeds[keys.find(key => key !== action.key && key !== state.activeKey)!];
    return { ...state, feeds };
  }
  if (action.type === 'error') {
    const feed = state.feeds[action.key];
    if (!feed || feed.generation !== action.generation) return state;
    return { ...state, feeds: { ...state.feeds, [action.key]: { ...feed, loading: false, error: action.error } } };
  }
  if (action.type === 'page' || action.type === 'context') {
    if (action.type === 'page' && state.feeds[action.key]?.generation !== action.generation) return state;
    const messages = mergeEntities(state.messages, action.page.messages);
    const users = { ...state.users };
    for (const user of action.page.users) users[user.id] = user;
    const memberships = { ...state.memberships };
    const membershipSequences = { ...state.membershipSequences };
    // An old HTTP response must not undo newer membership events.
    for (const membership of action.page.memberships) if (action.page.sequence >= (membershipSequences[membership.memberId] ?? state.sequence)) { memberships[membership.memberId] = membership; membershipSequences[membership.memberId] = action.page.sequence; }
    const knownMembers = new Set(action.page.memberships.map(membership => membership.memberId));
    for (const message of action.page.messages) if (!knownMembers.has(message.id) && action.page.sequence >= (membershipSequences[message.id] ?? state.sequence)) { delete memberships[message.id]; membershipSequences[message.id] = action.page.sequence; }
    const next = { ...state, messages, users, memberships, membershipSequences, ...mergeStates(state, action.page.states, action.page.sequence), ...(action.type === 'page' && state.feeds[action.key]?.query.viewer === state.personalViewer ? mergePersonal(state, action.page) : {}) };
    if (action.type === 'context') return trimStore(next);
    const feed = state.feeds[action.key];
    const freshLocal = action.append ? feed.ids : feed.ids.filter(id => (messages[id]?.sequence ?? 0) > action.page.sequence && matches(messages[id], feed.query, memberships, next.personalStates));
    const ids = Array.from(new Set([...freshLocal, ...action.page.messages.map(message => message.id)])).slice(0, PAGE_LIMIT);
    next.feeds = { ...state.feeds, [action.key]: { ...feed, ids, cursor: ids.length >= PAGE_LIMIT ? null : action.page.nextCursor, loading: false, error: null } };
    if (!state.initialized) { next.sequence = action.page.sequence; next.initialized = true; }
    return trimStore(next);
  }
  if (action.type === 'change' && action.change.sequence <= state.sequence) return state;
  const messages = mergeEntities(state.messages, action.change.messages);
  const memberships = { ...state.memberships };
  const membershipSequences = { ...state.membershipSequences };
  for (const id of action.change.removedMemberships) if (action.change.sequence >= (membershipSequences[id] ?? 0)) { delete memberships[id]; membershipSequences[id] = action.change.sequence; }
  for (const membership of action.change.memberships) if (action.change.sequence >= (membershipSequences[membership.memberId] ?? 0)) { memberships[membership.memberId] = membership; membershipSequences[membership.memberId] = action.change.sequence; }
  const affected = new Set([...action.change.messages.map(message => message.id), ...action.change.removedMemberships, ...action.change.memberships.map(membership => membership.memberId)]);
  const feeds = { ...state.feeds };
  for (const [key, feed] of Object.entries(feeds)) {
    if (feed.query.personal === 'notifications') continue;
    const ids = feed.ids.filter(id => !affected.has(id) || (messages[id] && matches(messages[id], feed.query, memberships, state.personalStates)));
    for (const id of affected) if (messages[id] && matches(messages[id], feed.query, memberships, state.personalStates) && !ids.includes(id)) ids.unshift(id);
    feeds[key] = { ...feed, ids: ids.slice(0, PAGE_LIMIT) };
  }
  return trimStore({ ...state, messages, memberships, membershipSequences, feeds, ...mergeStates(state, action.change.states, action.change.sequence), sequence: action.type === 'ack' ? state.sequence : action.change.sequence });
}

function trimStore(state: Store): Store {
  const entries = Object.values(state.messages);
  if (entries.length <= 2000) return state;
  const protectedIds = new Set(Object.values(state.feeds).flatMap(feed => feed.ids));
  const recent = entries.filter(message => !protectedIds.has(message.id)).sort((a, b) => b.sequence - a.sequence).slice(0, 500);
  const keep = new Set([...protectedIds, ...recent.map(message => message.id)]);
  return { ...state, messages: Object.fromEntries(entries.filter(message => keep.has(message.id)).map(message => [message.id, message])) };
}
