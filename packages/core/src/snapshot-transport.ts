interface SnapshotRecords {
  messages: object[];
  relations: object[];
}

/** Transport-only references; decoding restores the complete original view. */
export type CompactSnapshot<T extends SnapshotRecords> = Omit<T, 'relations'> & {
  snapshotEncoding: 'relations-v1';
  relationRecords: Array<number | T['relations'][number]>;
};

export function encodeWorkbenchSnapshot<T extends SnapshotRecords>(snapshot: T): CompactSnapshot<T> {
  const { relations, ...data } = snapshot;
  const indexes = new Map(snapshot.messages.map((message, index) => [message, index]));
  return {
    ...data,
    snapshotEncoding: 'relations-v1',
    // Only share identical records. A relation carrying additional fields stays
    // inline, so a future projection cannot silently lose those fields.
    relationRecords: relations.map(relation => indexes.get(relation) ?? relation),
  };
}

export function decodeWorkbenchSnapshot<T extends SnapshotRecords>(snapshot: T | CompactSnapshot<T>): T {
  if (!('snapshotEncoding' in snapshot)) return snapshot as T;
  const wire = snapshot as CompactSnapshot<T>;
  if (wire.snapshotEncoding !== 'relations-v1') throw new Error('不支持的工作台快照格式');
  const { snapshotEncoding: _encoding, relationRecords, ...data } = wire;
  const relations = relationRecords.map(record => {
    if (typeof record !== 'number') return record;
    if (!Number.isSafeInteger(record) || record < 0 || record >= wire.messages.length) {
      throw new Error('工作台快照中的关系引用无效');
    }
    return wire.messages[record];
  });
  return { ...data, relations } as unknown as T;
}
