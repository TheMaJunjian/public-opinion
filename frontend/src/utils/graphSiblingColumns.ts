import { CARD_W, COL_GAP, GRID_LEFT } from './layout';

interface ColumnItem { id: string; column: number; width: number }
export type ColumnConstraints = Array<readonly [string, string]>;

/** Order siblings before assigning pixels. Cycles share a lane and stack vertically. */
export function siblingColumns(items: ColumnItem[], constraints: ColumnConstraints, compact = true) {
  const byId = new Map(items.map(item => [item.id, item]));
  const next = new Map(items.map(item => [item.id, new Set<string>()]));
  const previous = new Map(items.map(item => [item.id, new Set<string>()]));
  for (const [left, right] of constraints) if (left !== right && byId.has(left) && byId.has(right)) {
    next.get(left)!.add(right); previous.get(right)!.add(left);
  }
  const seen = new Set<string>(), finish: string[] = [];
  for (const item of items) {
    const stack: Array<[string, boolean]> = [[item.id, false]];
    while (stack.length) {
      const [id, done] = stack.pop()!;
      if (done) { finish.push(id); continue; }
      if (seen.has(id)) continue;
      seen.add(id); stack.push([id, true]);
      for (const child of next.get(id)!) if (!seen.has(child)) stack.push([child, false]);
    }
  }
  const group = new Map<string, number>(), ranks: number[] = [];
  for (const start of finish.reverse()) {
    if (group.has(start)) continue;
    const index = ranks.length, stack = [start]; ranks.push(0);
    while (stack.length) {
      const id = stack.pop()!;
      if (group.has(id)) continue;
      group.set(id, index); ranks[index] = Math.max(ranks[index], byId.get(id)!.column);
      for (const parent of previous.get(id)!) if (!group.has(parent)) stack.push(parent);
    }
  }
  const dependents = ranks.map(() => new Set<number>()), degrees = ranks.map(() => 0);
  for (const [id, targets] of next) for (const target of targets) {
    const left = group.get(id)!, right = group.get(target)!;
    if (left !== right && !dependents[left].has(right)) { dependents[left].add(right); degrees[right]++; }
  }
  const queue = degrees.flatMap((degree, index) => degree === 0 ? [index] : []);
  for (let index = 0; index < queue.length; index++) for (const right of dependents[queue[index]]) {
    ranks[right] = Math.max(ranks[right], ranks[queue[index]] + 1);
    if (--degrees[right] === 0) queue.push(right);
  }
  const ordered = [...new Set(ranks)].sort((a, b) => a - b);
  const indexes = new Map(ordered.map((rank, index) => [rank, index]));
  const columns = new Map(items.map(item => [item.id, compact ? indexes.get(ranks[group.get(item.id)!])! : ranks[group.get(item.id)!]]));
  const widths = new Map<number, number>();
  for (const item of items) widths.set(columns.get(item.id)!, Math.max(widths.get(columns.get(item.id)!) ?? CARD_W, item.width));
  const origins = new Map<number, number>();
  let x = GRID_LEFT, lastColumn = -1;
  for (const column of [...widths.keys()].sort((a, b) => a - b)) {
    if (!compact) x += Math.max(0, column - lastColumn - 1) * (CARD_W + COL_GAP);
    origins.set(column, x); x += widths.get(column)! + COL_GAP; lastColumn = column;
  }
  return { columns, xById: new Map(items.map(item => [item.id, origins.get(columns.get(item.id)!)!])) };
}
