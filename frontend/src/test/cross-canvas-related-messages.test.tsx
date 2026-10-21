import { fireEvent, render, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CrossCanvasRelatedMessages from '../components/CrossCanvasRelatedMessages';
import { deriveCrossCanvasRelations } from '../utils/crossCanvasRelations';
import type { DemoEdge } from '../utils/modelBridge';
import { loadRelatedTraceContext } from '../utils/relatedTraceContext';
import type { Message, Relation } from '../types';

const edge = (type: DemoEdge['relationType'], id = 'relation', from = 'source', to = 'target'): DemoEdge => ({
  id: `${id}:${to}`, relationMessageId: id, relationType: type, relationLabel: '自定义标签',
  from: { messageId: from, selection: { kind: 'whole' } }, to: { messageId: to, selection: { kind: 'whole' } },
});
const index = (edges: DemoEdge[], ids: string[], renderedEdges?: DemoEdge[]) => deriveCrossCanvasRelations({ edges, visibleMessageIds: new Set(ids), renderedEdges });

it.each(['reference', 'reply', 'annotation', 'notify', 'authorize', 'agree', 'disagree'] as const)('attaches cross-canvas %s to the source and target independently', type => {
  const edges = [edge(type)];
  expect(Object.values(index(edges, ['source']).get('source')!.outgoing)).toEqual([['relation']]);
  expect(Object.values(index(edges, ['target']).get('target')!.incoming)).toEqual([['relation']]);
  expect(index(edges, ['source', 'target']).size).toBe(0);
  expect(index(edges, []).size).toBe(0);
});

it.each(['agree', 'disagree'] as const)('does not add a separate related entry for a pure %s vote with no source message', type => {
  expect(index([edge(type, 'vote', 'anon:vote')], ['target']).size).toBe(0);
});

it('deduplicates fragments and targets while retaining missing connections beside a complete local edge', () => {
  const local = edge('reference', 'relation', 'source', 'local');
  const remote = edge('reference', 'relation', 'source', 'remote');
  const duplicate = { ...remote, id: 'fragment' };
  const groups = index([local, remote, duplicate], ['source', 'local'], [local]);
  expect(groups.get('source')?.outgoing).toEqual({ '引用': ['relation'] });
  expect(groups.has('local')).toBe(false);
  expect(index([edge('reference')], ['source', 'target'], []).get('target')?.incoming).toEqual({ '引用': ['relation'] });
  expect(index([edge('agree'), edge('classify'), edge('join' as DemoEdge['relationType']), edge('reference', 'anonymous', 'anon:source')], ['source', 'target']).size).toBe(0);
});

it('starts collapsed, groups directions, shows only type and ID, and opens the selected relation', () => {
  const open = vi.fn(), parentClick = vi.fn();
  const view = render(<div onClick={parentClick}><CrossCanvasRelatedMessages messages={new Map()} onView={open}
    groups={{ outgoing: { '引用': ['out', 'out'] }, incoming: { '回复': ['in'] } }} /></div>);
  const toggle = view.getByRole('button', { name: '▸ 相关消息：2' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(view.queryByRole('button', { name: '查看' })).toBeNull();
  fireEvent.click(toggle);
  const outgoing = within(view.getByRole('group', { name: '发出的关联' }));
  const incoming = within(view.getByRole('group', { name: '指向本消息的关联' }));
  expect(outgoing.getByRole('button', { name: '选择相关引用消息部件' })).toHaveTextContent('【引用】 out');
  expect(incoming.getByRole('button', { name: '选择相关回复消息部件' })).toHaveTextContent('【回复】 in');
  fireEvent.click(outgoing.getByRole('button', { name: '查看' }));
  expect(open).toHaveBeenCalledWith('out');
  expect(parentClick).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(view.queryByRole('group')).toBeNull();
});

it('lets blank areas select the owning card while keeping related-message controls isolated', () => {
  const click = vi.fn(), doubleClick = vi.fn(), mouseDown = vi.fn(), mouseUp = vi.fn();
  const view = render(<div onClick={click} onDoubleClick={doubleClick} onMouseDown={mouseDown} onMouseUp={mouseUp}>
    <CrossCanvasRelatedMessages messages={new Map()} groups={{ outgoing: { '引用': ['out'] }, incoming: {} }} />
  </div>);
  const interact = (element: Element) => {
    fireEvent.mouseDown(element);
    fireEvent.mouseUp(element);
    fireEvent.click(element);
    fireEvent.doubleClick(element);
  };
  interact(view.container.querySelector('[data-cross-canvas-related-messages]')!);
  for (const handler of [click, doubleClick, mouseDown, mouseUp]) expect(handler).toHaveBeenCalledTimes(1);

  interact(view.getByRole('button', { name: '▸ 相关消息：1' }));
  interact(view.getByRole('button', { name: '选择相关引用消息部件' }));
  interact(view.getByRole('button', { name: '查看' }));
  for (const handler of [click, doubleClick, mouseDown, mouseUp]) expect(handler).toHaveBeenCalledTimes(1);

  interact(view.container.querySelector('[data-related-relation-id="out"]')!);
  for (const handler of [click, doubleClick, mouseDown, mouseUp]) expect(handler).toHaveBeenCalledTimes(2);
});

it('loads missing endpoints through transparent relation targets without fetching known cards or following cycles',async()=>{
  const user={id:'u',username:'用户',createdAt:''};
  const remote:Relation={id:'remote',relationType:'REFERENCE',sourceMessageId:'source',targetRefs:[{kind:'relation',relationId:'relation'},{kind:'message',messageId:'target'}],createdAt:'',createdBy:user};
  const view:Message={id:'remote',kind:'RELATION',content:'',contentType:'TEXT',relationType:'REFERENCE',relSourceId:'source',targetRefs:remote.targetRefs,createdAt:'',createdBy:user};
  const target:Message={id:'target',kind:'TEXT',content:'远端消息',contentType:'TEXT',createdAt:'',createdBy:user};
  const load=vi.fn().mockResolvedValueOnce({messages:[view],relations:[remote]}).mockResolvedValueOnce({messages:[target],relations:[]});
  const context=await loadRelatedTraceContext('relation',[
    {id:'source',kind:'normal',author:'用户',content:'来源',createdAt:''},
    {id:'relation',kind:'relation',relationType:'reference',author:'用户',content:'',createdAt:''},
  ],[edge('reference','relation','source','remote')],load);
  expect(load.mock.calls.map(([ids])=>ids)).toEqual([['remote'],['target']]);
  expect(context.messages.map(message=>message.id)).toEqual(['remote','target']);
  expect(context.relations.map(relation=>relation.id)).toEqual(['remote']);
});
