/** Read a JSON object's large message arrays one record at a time. Offsets are
 * UTF-8 byte positions, so later Blob.slice reads never need the whole string. */
export type JsonRange = [start: number, end: number];
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export async function scanJsonArchive(blob: Blob, record: (field: 'messages' | 'relations', row: unknown, range: JsonRange) => void,
  options: { signal?: AbortSignal; progress?: (bytes: number) => void; chunkSize?: number } = {}): Promise<Record<string, unknown>> {
  type State = 'start' | 'keyFirst' | 'key' | 'colon' | 'value' | 'arrayFirst' | 'arrayValue' | 'arrayAfter' | 'after' | 'end';
  let state: State = 'start', key = '', token = false, quoted = false, escaped = false, depth = 0, primitive = false;
  let tokenStart = 0, segment = 0, tokenKind: 'key' | 'value' | 'record' = 'value';
  let fragments: Uint8Array[] = [];
  const metadata: Record<string, unknown> = {}, keys = new Set<string>(), decoder = new TextDecoder('utf-8', { fatal: true });
  const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
  const invalid = () => { throw new Error('JSON 文件结构不完整或格式无效'); };
  const finish = (bytes: Uint8Array, end: number, absolute: number) => {
    fragments.push(bytes.subarray(segment, end));
    let content: Uint8Array;
    if (fragments.length === 1) content = fragments[0];
    else {
      content = new Uint8Array(fragments.reduce((size, part) => size + part.length, 0));
      let offset = 0;
      for (const part of fragments) { content.set(part, offset); offset += part.length; }
    }
    const value: unknown = JSON.parse(decoder.decode(content));
    if (tokenKind === 'key') {
      if (typeof value !== 'string' || keys.has(value)) invalid();
      key = value as string; keys.add(key); state = 'colon';
    } else if (tokenKind === 'record') {
      record(key as 'messages' | 'relations', value, [tokenStart, absolute]); state = 'arrayAfter';
    } else { Object.defineProperty(metadata, key, { value, enumerable: true, configurable: true }); state = 'after'; }
    fragments = []; token = false;
  };
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  let lastYield = performance.now();
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    options.signal?.throwIfAborted();
    const bytes = await blobBytes(blob.slice(offset, Math.min(offset + chunkSize, blob.size)));
    segment = 0;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (token) {
        if (primitive && !quoted && (whitespace(byte) || byte === 44 || byte === 93 || byte === 125)) {
          finish(bytes, i, offset + i); i--; continue;
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) { quoted = false; if (!depth) finish(bytes, i + 1, offset + i + 1); }
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) depth++;
        else if (byte === 125 || byte === 93) { if (--depth === 0) finish(bytes, i + 1, offset + i + 1); }
        continue;
      }
      if (whitespace(byte)) continue;
      switch (state as State) {
        case 'start': if (byte !== 123) invalid(); state = 'keyFirst'; continue;
        case 'end': invalid(); break;
        case 'keyFirst': if (byte === 125) { state = 'end'; continue; } break;
        case 'colon': if (byte !== 58) invalid(); state = 'value'; continue;
        case 'after':
          if (byte === 125) { state = 'end'; continue; }
          if (byte !== 44) invalid(); state = 'key'; continue;
        case 'arrayAfter':
          if (byte === 93) { state = 'after'; continue; }
          if (byte !== 44) invalid(); state = 'arrayValue'; continue;
        case 'arrayFirst': if (byte === 93) { state = 'after'; continue; } break;
      }
      if (state === 'value' && (key === 'messages' || key === 'relations')) {
        if (byte !== 91) invalid(); metadata[key] = []; state = 'arrayFirst'; continue;
      }
      tokenKind = state === 'key' || state === 'keyFirst' ? 'key'
        : state === 'arrayValue' || state === 'arrayFirst' ? 'record' : 'value';
      if (tokenKind === 'key' && byte !== 34) invalid();
      if (tokenKind === 'record' && byte !== 123) invalid();
      token = true; tokenStart = offset + i; segment = i;
      quoted = byte === 34; escaped = false; depth = byte === 123 || byte === 91 ? 1 : 0;
      primitive = !quoted && !depth;
    }
    if (token) fragments.push(bytes.slice(segment));
    options.progress?.(Math.min(offset + bytes.length, blob.size));
    // Also keep the worker-less fallback responsive on cached, fast Blob reads.
    if (performance.now() - lastYield > 12) { await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now(); }
  }
  options.signal?.throwIfAborted();
  if (token || state !== 'end') invalid();
  return metadata;
}
