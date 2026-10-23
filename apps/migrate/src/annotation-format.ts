import type {Part} from '@gonglun/core';

type RecordValue = Record<string,any>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const oldNames: Record<string,string> = {follow:'follow',unfollow:'follow',block:'block',unblock:'block'};

/** Used only by the migration executable, including imports from a previous release. */
export function upgradeAnnotationRecords(value: any): any {
  if (Array.isArray(value)) return value.map(upgradeAnnotationRecords);
  if (!object(value)) return value;
  const result: RecordValue = Object.fromEntries(Object.entries(value).map(([key,child]) => [key,
    key === 'input' || key === 'parts' ? child : upgradeAnnotationRecords(child)]));
  if (typeof value.id !== 'string') return result;
  const parts: Part[] | undefined = Array.isArray(value.parts) ? structuredClone(value.parts) : undefined;
  if (parts) {
    const data = Object.assign({},...parts.flatMap(part => part.type === 'data' && object(part.value) ? [part.value] : []));
    let first: Extract<Part,{type:'relation'}> | undefined;
    for (const part of parts) {
      if (part.type !== 'relation' || !oldNames[part.relation]) continue;
      part.reason = part.reason ?? (data.subType === 'YES' || data.subType === 'NO' ? data.subType
        : part.relation === 'unfollow' || part.relation === 'unblock' ? 'NO' : 'YES');
      part.relation = oldNames[part.relation]!;
      first ??= part;
    }
    if (first) {
      for (const part of parts) if (part.type === 'data' && object(part.value) && 'uiType' in part.value)
        part.value = {...part.value,uiType:first.relation === 'follow' ? 'ATTENTION' : 'BLOCK',subType:first.reason!};
      result.parts = parts;
      if (value.relationType) result.relationType = first.relation === 'follow' ? 'ATTENTION' : 'BLOCK';
      for (const key of ['payload','relationPayload']) if (object(result[key])) result[key] = {...result[key],subType:first.reason};
    }
  }
  // Persisted workbench responses may contain projected records without native parts.
  if (['ATTENTION','UNFOLLOW','BLOCK','UNBLOCK'].includes(value.relationType)) {
    const payload = value.payload ?? value.relationPayload ?? {};
    const reason = result.parts?.find((part:Part) => part.type === 'relation' && ['follow','block'].includes(part.relation))?.reason
      ?? (payload.subType === 'YES' || payload.subType === 'NO' ? payload.subType
        : ['UNFOLLOW','UNBLOCK'].includes(value.relationType) ? 'NO' : 'YES');
    result.relationType = ['ATTENTION','UNFOLLOW'].includes(value.relationType) ? 'ATTENTION' : 'BLOCK';
    for (const key of ['payload','relationPayload']) if (key in value) result[key] = {...result[key],subType:reason};
    if(!('payload' in value)&&!('relationPayload' in value))result.payload={subType:reason};
  }
  return result;
}
