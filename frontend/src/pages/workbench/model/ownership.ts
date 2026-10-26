import type { Relation, TargetRef } from '../../../types';
import { getEffectiveJoinByTarget } from './membership';
import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';
import { expandTextIdsWithCorrections } from './correction';
import { displayDependencyIds } from '../../../utils/displayDependency';
type ContainerRelation = Pick<Relation,'id'|'relationType'|'sourceMessageId'|'targetRefs'> & Partial<Pick<Relation,'payload'|'state'|'createdAt'>>;
const containerTypes=new Set(['CLASSIFY','SUMMARY','MERGE','ARRANGE']);

/** Build once per traversal. Avoid scanning every relation for every member. */
function ownershipIndex(relations:ContainerRelation[],rejected:Set<string>,rejectedJoins:Set<string>,displayWinners?:ReadonlyMap<string,string>) {
  const byId=new Map(relations.map(relation=>[relation.id,relation]));
  const retired=new Set(relations.filter(relation=>relation.state?.organizationRetired).map(relation=>relation.id));
  const normalize=(ref:TargetRef):TargetRef=>ref.kind!=='relation'&&containerTypes.has(byId.get(ref.messageId)?.relationType?.toUpperCase()??'')?{kind:'relation',relationId:ref.messageId}:ref;
  const key=(ref:TargetRef)=>{const normalized=normalize(ref);return normalized.kind==='relation'?`r:${normalized.relationId}`:`m:${normalized.messageId}`;};
  const effective=displayWinners??getEffectiveJoinByTarget(relations,rejected,rejectedJoins);
  const releasedDeclarations=new Map<string,Map<string,string>>();
  const effectiveFor=(id:string)=>{
    if(byId.get(id)?.payload?.independentMemberships||(bySource.get(id)??[]).some(join=>join.payload?.membershipHistory)||!rejected.has(id))return effective;
    let result=releasedDeclarations.get(id);
    if(!result){
      const parents=new Set(rejected);parents.delete(id);
      result=getEffectiveJoinByTarget(relations,parents,rejectedJoins);
      if(displayWinners){
        result=new Map([...result].filter(([target,joinId])=>!displayWinners.has(target)&&byId.get(joinId)?.sourceMessageId===id));
        for(const [target,joinId] of displayWinners)result.set(target,joinId);
      }
      releasedDeclarations.set(id,result);
    }
    return result;
  };
  const bySource=new Map<string,ContainerRelation[]>(),byTarget=new Map<string,ContainerRelation[]>();
  for(const relation of relations) if(relation.relationType?.toUpperCase()==='JOIN') {
    if(relation.sourceMessageId) (bySource.get(relation.sourceMessageId)??(bySource.set(relation.sourceMessageId,[]),bySource.get(relation.sourceMessageId)!)).push(relation);
    for(const ref of relation.targetRefs??[]) (byTarget.get(key(ref))??(byTarget.set(key(ref),[]),byTarget.get(key(ref))!)).push(relation);
  }
  const direct=(id:string)=>{
    const textIds=new Set<string>(),relationIds=new Set<string>(),relation=byId.get(id);
    const add=(ref:TargetRef)=>{const normalized=normalize(ref);if(retired.has(normalized.kind==='relation'?normalized.relationId:normalized.messageId))return;if(normalized.kind==='relation')relationIds.add(normalized.relationId);else textIds.add(normalized.messageId);};
    if(!relation||retired.has(id))return {textIds,relationIds};
    const memberJoins=effectiveFor(id);
    if(relation.relationType?.toUpperCase()==='ARRANGE'&&relation.sourceMessageId)textIds.add(relation.sourceMessageId);
    for(const ref of relation.targetRefs??[]) {
      if (relation.payload?.independentMemberships) continue;
      const joins=byTarget.get(key(ref));
      const targetId=ref.kind==='relation'?ref.relationId:ref.messageId;
      if(!joins?.length||joins.some(join=>join.sourceMessageId===id&&memberJoins.get(targetId)===join.id))add(ref);
    }
    for(const join of bySource.get(id)??[]) for(const ref of join.targetRefs??[])if(memberJoins.get(ref.kind==='relation'?ref.relationId:ref.messageId)===join.id)add(ref);
    return {textIds,relationIds};
  };
  return {byId,direct};
}

export function collectContainerVisibleIds(containerId:string,relations:ContainerRelation[],rejectedContainerIds=new Set<string>(),rejectedJoinRelationIds=new Set<string>()) {
  return ownershipIndex(relations,rejectedContainerIds,rejectedJoinRelationIds).direct(containerId);
}

export function collectOwnedByRelation(relationId:string,relationById:Map<string,Relation>,visited=new Set<string>(),rejectedContainerIds=new Set<string>(),rejectedJoinRelationIds=new Set<string>()) {
  return createContainerOwnership([...relationById.values()],rejectedContainerIds,rejectedJoinRelationIds).owned(relationId,visited);
}

/** One consistent membership index for a real or simulated organization state. */
export function createContainerOwnership(relations:ContainerRelation[],rejectedContainerIds=new Set<string>(),rejectedJoinRelationIds=new Set<string>(),displayWinners?:ReadonlyMap<string,string>) {
  const index=ownershipIndex(relations,rejectedContainerIds,rejectedJoinRelationIds,displayWinners);
  const cached=new Map<string,{textIds:Set<string>;relationIds:Set<string>}>();
  const owned=(relationId:string,visited=new Set<string>())=>{
  const cacheable=visited.size===0;
  if(cacheable&&cached.has(relationId))return cached.get(relationId)!;
  const result={textIds:new Set<string>(),relationIds:new Set<string>()};
  const visit=(id:string)=>{
    if(visited.has(id))return;
    visited.add(id);
    const direct=index.direct(id);
    for(const text of direct.textIds)result.textIds.add(text);
    for(const childId of direct.relationIds) {
      result.relationIds.add(childId);
      const child=index.byId.get(childId);
      // Rejection dissolves this child into its parent canvas, not out of all
      // ancestor scopes. Ancestors must still own the released descendants.
      if(!child||!containerTypes.has(child.relationType.toUpperCase()))continue;
      visit(childId);
    }
  };
  visit(relationId);
  if(cacheable)cached.set(relationId,result);
  return result;
  };
  const active=(type:string,scopeOwners?:ReadonlySet<string>)=>{
    const result={textIds:new Set<string>(),relationIds:new Set<string>()};
    for(const relation of relations){
      if(relation.relationType.toUpperCase()!==type.toUpperCase()||rejectedContainerIds.has(relation.id)||(scopeOwners&&!scopeOwners.has(relation.id)))continue;
      const members=owned(relation.id);
      members.textIds.forEach(id=>result.textIds.add(id));
      members.relationIds.forEach(id=>result.relationIds.add(id));
    }
    return result;
  };
  const released=(id:string)=>{
    const result={textIds:new Set<string>(),relationIds:new Set<string>()},visited=new Set<string>();
    const visit=(parent:string)=>{
      if(visited.has(parent))return;visited.add(parent);
      const direct=index.direct(parent);
      direct.textIds.forEach(member=>result.textIds.add(member));
      for(const member of direct.relationIds){
        result.relationIds.add(member);
        const type=index.byId.get(member)?.relationType.toUpperCase();
        if(type==='MERGE'||type==='ARRANGE'||rejectedContainerIds.has(member))visit(member);
      }
    };
    visit(id);return result;
  };
  return {direct:index.direct,owned,active,released};
}

export type ContainerOwnership=ReturnType<typeof createContainerOwnership>;

export interface FindContainingClassificationInput {
  relationById: Map<string,Relation>;
  relations: Relation[];
  rejectedContainerIds: Set<string>;
  rejectedJoinRelationIds: Set<string>;
  containerOwnership?: ContainerOwnership;
  edges?: DemoEdge[];
  msgMap?: Map<string, DemoMessage>;
}

export function findContainingClassification(dependencies: FindContainingClassificationInput, messageId: string): string | null {
  const { relationById, relations, rejectedContainerIds, rejectedJoinRelationIds, edges, msgMap } = dependencies;
  const ownership = dependencies.containerOwnership ?? createContainerOwnership(relations, rejectedContainerIds, rejectedJoinRelationIds);
  let anchorId = messageId;
  const visited = new Set<string>();
  while (!visited.has(anchorId)) {
    visited.add(anchorId);
    const relation = relationById.get(anchorId);
    // JOIN records have their own history navigation, rather than entering the parent's scope.
    if (relation?.relationType.toUpperCase() === 'JOIN') break;
    const host = relation && displayDependencyIds(relation)?.[0];
    if (!host) break;
    anchorId = host;
  }
  let match: { id: string; size: number } | null = null;
  for (const relation of relations) {
    if (!['CLASSIFY', 'SUMMARY'].includes(relation.relationType) || rejectedContainerIds.has(relation.id)) continue;
    const owned = ownership.owned(relation.id);
    const textIds = edges && msgMap ? expandTextIdsWithCorrections(owned.textIds, edges, msgMap) : owned.textIds;
    if (!textIds.has(anchorId) && !owned.relationIds.has(anchorId)) continue;
    const size = owned.textIds.size + owned.relationIds.size;
    if (!match || size < match.size) match = { id: relation.id, size };
  }
  return match?.id ?? null;
}

/**
 * Walk up the container chain: find all ancestor containers of a given container
 * by following JOIN relations that target it.
 * Returns a Set of container IDs ordered from innermost to outermost.
 */
export function getContainerAncestorChain(
  containerId: string,
  relations: Relation[],
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  const containerRelationTypes = new Set(['CLASSIFY', 'SUMMARY', 'MERGE', 'ARRANGE']);
  let current = containerId;

  while (current && !visited.has(current)) {
    visited.add(current);
    // Find a JOIN relation whose targetRefs contain `current`.
    const joinRel = relations.find(r =>
      r.relationType?.toUpperCase() === 'JOIN' &&
      !!r.sourceMessageId &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === current) ||
        (ref.kind === 'message' && ref.messageId === current)
      )
    );
    const directParent = joinRel ? undefined : relations.find(r =>
      containerRelationTypes.has(r.relationType?.toUpperCase() ?? '') &&
      (r.targetRefs as TargetRef[]).some(ref =>
        (ref.kind === 'relation' && ref.relationId === current) ||
        (ref.kind === 'message' && ref.messageId === current)
      )
    );
    const parentId = joinRel?.sourceMessageId ?? directParent?.id;
    if (!parentId) break;
    chain.push(parentId);
    current = parentId;
  }

  return chain;
}

/**
 * Check whether two containers are on the same ancestor chain.
 */
export function areContainersOnSameChain(
  a: string,
  b: string,
  relations: Relation[],
): boolean {
  if (a === b) return true;
  const chainA = new Set(getContainerAncestorChain(a, relations));
  const chainB = getContainerAncestorChain(b, relations);
  // If b is in a's ancestor chain, or a is in b's ancestor chain
  if (chainA.has(b)) return true;
  if (chainB.includes(a)) return true;
  return false;
}
