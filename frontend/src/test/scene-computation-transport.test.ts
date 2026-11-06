import { expect, it } from 'vitest';
import { createSceneRequestEncoder, createSceneRequestDecoder } from '../utils/sceneComputationTransport';
import { computeSceneLayout } from '../utils/frameLayout';
import type { SceneComputationJob } from '../utils/sceneComputationInput';
import type { DemoMessage } from '../utils/modelBridge';

const messages: DemoMessage[] = ['a', 'b'].map(id => ({id, kind:'normal', author:'test', content:id, createdAt:''}));
const initial = (): Extract<SceneComputationJob, {kind:'layout'}> => ({kind:'layout',input:{normals:messages,allMessages:messages,
  edges:[],colOf:{a:0,b:0},maxCol:0,measuredHeights:{a:100,b:120},measuredWidths:{}}});

it('sends changed measurements without another copy of the topology and computes the same layout', () => {
  const encode=createSceneRequestEncoder(), decode=createSceneRequestDecoder(), first=initial();
  const transmitted=structuredClone(encode(1,first)), workerFirst=decode(transmitted);
  if(workerFirst.kind!=='layout')throw new Error('Unexpected job');
  const next={...first,input:{...first.input,measuredHeights:{a:650,b:120},measuredWidths:{a:480}}};
  const update=encode(3,next);
  expect(update).toEqual({id:3,patch:{baseId:1,input:{measuredHeights:{a:650,b:120},measuredWidths:{a:480}},removed:[]}});
  expect(JSON.stringify(update).length).toBeLessThan(200);
  const restored=decode(structuredClone(update));
  if(restored.kind!=='layout')throw new Error('Unexpected job');
  expect(restored.input.allMessages).toBe(workerFirst.input.allMessages);
  expect(restored.input.normals).toBe(workerFirst.input.normals);
  expect(restored.input.edges).toBe(workerFirst.input.edges);
  expect(computeSceneLayout(restored.input)).toEqual(computeSceneLayout(next.input));
  expect(workerFirst.input.measuredHeights.a).toBe(100);
});

it('removes obsolete layout options and preserves maps and sets across the worker boundary', () => {
  const encode=createSceneRequestEncoder(), decode=createSceneRequestDecoder();
  const base=initial(), first={...base,input:{...base.input,expandAllFrames:true,collapsedFrameIds:new Set(['old'])}};
  decode(structuredClone(encode(1,first)));
  const next={...base,input:{...base.input,collapsedFrameIds:new Set(['new'])}};
  const request=encode(2,next), restored=decode(structuredClone(request));
  expect('patch' in request&&request.patch.removed).toEqual(['expandAllFrames']);
  expect(restored.input).not.toHaveProperty('expandAllFrames');
  expect(restored.input).toEqual(next.input);
});

it('sends a complete input for changed message data, changed edges, or a different job kind', () => {
  const encode=createSceneRequestEncoder(), first=initial();
  encode(1,first);
  const next={...first,input:{...first.input,allMessages:structuredClone(messages)}};
  expect(encode(2,next)).toEqual({id:2,job:next});
  const changedEdges={...next,input:{...next.input,edges:[]}};
  expect(encode(3,changedEdges)).toEqual({id:3,job:changedEdges});
  const structures:SceneComputationJob={kind:'structures',input:{messages,edges:[]}};
  expect(encode(4,structures)).toEqual({id:4,job:structures});
  expect(encode(5,first)).toEqual({id:5,job:first});
});

it('rejects updates based on missing or stale worker inputs and starts a new worker with a full input', () => {
  const encode=createSceneRequestEncoder(), decode=createSceneRequestDecoder(), first=initial();
  decode(encode(1,first));
  const request=encode(2,{...first,input:{...first.input,measuredHeights:{a:200,b:120}}});
  expect(()=>createSceneRequestDecoder()(request)).toThrow('布局输入已失效');
  decode(request);
  expect(()=>decode(request)).toThrow('布局输入已失效');
  const fresh=createSceneRequestEncoder()(9,first);
  expect(createSceneRequestDecoder()(structuredClone(fresh))).toEqual(first);
});
