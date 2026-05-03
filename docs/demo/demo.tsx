import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/** =========================
 *  Types
 *  ========================= */

type MessageKind = "normal" | "relation";
type RelationType =
  | "annotation"
  | "reference"
  | "reply"
  | "agree"
  | "disagree"
  | "support"
  | "rebut";
type SecondaryRelationType = "none" | "annotation" | "reference";

type Message = {
  id: string;
  author: string;
  createdAt: string;
  content: string;
  kind: MessageKind;
};

type Selection =
  | { kind: "whole" }
  | { kind: "text"; start: number; len: number; text: string } // UTF-16 code unit offsets
  | { kind: "edge"; edgeId: string };

type UnitSelection = {
  messageId: string;
  selection: Selection;
};

type Edge = {
  id: string;
  relationMessageId: string;
  relationType: RelationType;
  from: UnitSelection; // source
  to: UnitSelection; // target
  relationLabel: string;
};

/** =========================
 *  IDs
 *  ========================= */

let idCounter = 1000;
function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** =========================
 *  Selection helpers
 *  ========================= */

function selKey(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === "whole") return `${u.messageId}::whole`;
  if (s.kind === "edge") return `${u.messageId}::edge:${s.edgeId}`;
  return `${u.messageId}::text:${s.start}:${s.len}:${s.text}`;
}

function unitEquals(a: UnitSelection, b: UnitSelection) {
  return selKey(a) === selKey(b);
}

function mergeUnits(base: UnitSelection[], added: UnitSelection[]) {
  const set = new Set(base.map(selKey));
  const res = [...base];
  for (const u of added) {
    const k = selKey(u);
    if (!set.has(k)) {
      set.add(k);
      res.push(u);
    }
  }
  return res;
}

function foldUpToWhole(units: UnitSelection[]) {
  const seen = new Set<string>();
  const res: UnitSelection[] = [];
  for (const u of units) {
    if (seen.has(u.messageId)) continue;
    seen.add(u.messageId);
    res.push({ messageId: u.messageId, selection: { kind: "whole" } });
  }
  return res;
}

function describeUnit(u: UnitSelection): string {
  const s = u.selection;
  if (s.kind === "whole") return `整条消息 ${u.messageId}`;
  if (s.kind === "edge")
    return `关系消息 ${u.messageId} 的边片段 @edge:${s.edgeId}`;
  return `消息 ${u.messageId} 的片段(start=${s.start}, len=${s.len})「${s.text}」`;
}

function selectionIsText(
  s: Selection
): s is { kind: "text"; start: number; len: number; text: string } {
  return s.kind === "text";
}

/** =========================
 *  Script format v2 (MSG len + END, REL + END)
 *  ========================= */

type ParsedScript = { messages: Message[]; edges: Edge[] };

function parseKV(s: string): Record<string, string> {
  const res: Record<string, string> = {};
  const parts = s.match(/(\S+?=\S+)/g);
  if (!parts) return res;
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx);
    const v = p.slice(idx + 1);
    res[k.trim()] = v.trim();
  }
  return res;
}

function relationTypeName(t: RelationType) {
  return t === "annotation"
    ? "注释"
    : t === "reference"
    ? "引用"
    : t === "reply"
    ? "回复"
    : t === "agree"
    ? "赞同"
    : t === "disagree"
    ? "反对"
    : t === "support"
    ? "支持"
    : "反驳";
}

function parseToLineStrict(toLine: string): {
  toId: string;
  selection: Selection;
} {
  const rest = toLine.replace(/^TO\s+/, "").trim();

  // TO <id> "@edge:edge-123"
  {
    const m = rest.match(/^(\S+)\s+"(@edge:[^"]+)"$/);
    if (m) {
      const toId = m[1];
      const edgeToken = m[2];
      const edgeId = edgeToken.slice("@edge:".length);
      return { toId, selection: { kind: "edge", edgeId } };
    }
  }

  // Support our decoration explicit syntax: TO <id> "@dec:agree:msg-123" or similar
  {
    const m = rest.match(/^(\S+)\s+"(@dec:[^"]+)"$/);
    if (m) {
      const toId = m[1];
      const edgeToken = m[2];
      const edgeId = edgeToken.slice("@dec:".length);
      return { toId, selection: { kind: "edge", edgeId } };
    }
  }

  // TO <id> start=<n> len=<m> "<text>"  (must be single-line)
  {
    const m = rest.match(/^(\S+)\s+start=(\d+)\s+len=(\d+)\s+"([\s\S]+)"$/);
    if (m) {
      const toId = m[1];
      const start = Number(m[2]);
      const len = Number(m[3]);
      const text = m[4];
      return { toId, selection: { kind: "text", start, len, text } };
    }
  }

  if (rest.includes('"')) {
    throw new Error(
      `Invalid TO line (missing start/len or invalid edge fragment): ${toLine}`
    );
  }

  return { toId: rest, selection: { kind: "whole" } };
}

function assertLineStartsWith(lines: string[], i: number, prefix: string) {
  if (i >= lines.length)
    throw new Error(`Unexpected EOF, expected line starting with: ${prefix}`);
  if (!lines[i].startsWith(prefix))
    throw new Error(
      `Expected line starting with '${prefix}', got: ${lines[i]}`
    );
}

/**
 * BUGFIX: read exactly `len` JS characters across subsequent lines joined by '\n'.
 * Returns { content, nextIndex } where nextIndex points to the line AFTER the consumed content.
 *
 * Rules:
 * - Between lines, joining includes a '\n' char (length 1).
 * - We consume whole lines and '\n' separators as needed.
 * - If len ends in the middle of a line, that's allowed; we treat the remaining tail of that line as "still in the stream".
 *   But because our storage is line-based, we cannot represent a partially consumed line as the next line.
 *   Therefore we DISALLOW mid-line cut and require that len ends on line boundary.
 *
 * This makes the format robust and human-editable: content should be whole lines.
 * (Your exporter always produces whole-line content, so this is fine.)
 */
function readContentByLen(
  lines: string[],
  startIndex: number,
  len: number
): { content: string; nextIndex: number } {
  if (len === 0) return { content: "", nextIndex: startIndex };

  let remaining = len;
  let i = startIndex;
  const parts: string[] = [];

  while (i < lines.length && remaining > 0) {
    const line = lines[i];
    const lineLen = line.length;

    if (lineLen > remaining) {
      throw new Error(
        `MSG len cuts mid-line at line ${
          i + 1
        }. Please ensure content len ends at a line boundary. remaining=${remaining}, lineLen=${lineLen}`
      );
    }

    parts.push(line);
    remaining -= lineLen;
    i++;

    if (remaining === 0) break;

    if (remaining < 1) {
      throw new Error(
        `MSG len cuts between lines without consuming newline properly at line ${i}.`
      );
    }
    parts.push("\n");
    remaining -= 1;
  }

  if (remaining !== 0) {
    throw new Error(`MSG content shorter than len=${len} (ran out of lines)`);
  }

  const content = parts.join("");
  return { content, nextIndex: i };
}

function parseInitialScriptV2(script: string): ParsedScript {
  const lines = script.split(/\r?\n/);
  const messages: Message[] = [];
  const edges: Edge[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith("MSG ")) {
      const meta = parseKV(line.slice(4).trim());
      const id = meta["id"] ?? nextId("msg");
      const author = meta["author"] ?? "Unknown";
      const time = meta["time"] ?? new Date().toISOString();
      const lenRaw = meta["len"];
      if (!lenRaw) throw new Error(`MSG missing len=: ${line}`);
      const len = Number(lenRaw);
      if (!Number.isFinite(len) || len < 0)
        throw new Error(`MSG invalid len=${lenRaw}: ${line}`);

      i++; // content starts at next line

      const { content, nextIndex } = readContentByLen(lines, i, len);
      i = nextIndex;

      assertLineStartsWith(lines, i, "END");
      i++; // consume END

      messages.push({ id, author, createdAt: time, content, kind: "normal" });
      continue;
    }

    if (line.startsWith("REL ")) {
      const meta = parseKV(line.slice(4).trim());
      const edgeId = meta["id"] ?? nextId("edge");
      const relmsg = meta["relmsg"] ?? nextId("rel");
      const relationType = (meta["type"] as RelationType) ?? "annotation";
      const relationLabel =
        meta["label"] ??
        (relationType === "annotation"
          ? "注释"
          : relationType === "reference"
          ? "引用"
          : relationType === "reply"
          ? "回复"
          : relationType === "agree"
          ? "赞同"
          : relationType === "disagree"
          ? "反对"
          : relationType === "support"
          ? "支持"
          : "反驳");

      i++;
      assertLineStartsWith(lines, i, "FROM ");
      const fromLine = lines[i].trim();
      i++;
      assertLineStartsWith(lines, i, "TO");
      const toLine = lines[i].trim();
      i++;
      assertLineStartsWith(lines, i, "END");
      i++;

      const fromId = fromLine.replace(/^FROM\s+/, "").trim();
      const { toId, selection } = parseToLineStrict(toLine);

      if (relationType === "reply" && selection.kind !== "whole") {
        throw new Error(
          `Reply relation must target whole message only. Bad TO: ${toLine}`
        );
      }

      const edge: Edge = {
        id: edgeId,
        relationMessageId: relmsg,
        relationType,
        from: { messageId: fromId, selection: { kind: "whole" } },
        to: { messageId: toId, selection },
        relationLabel,
      };
      edges.push(edge);

      if (!messages.some((m) => m.id === relmsg)) {
        const typeName = relationTypeName(relationType);
        const content = `建立${typeName}关系：${describeUnit(
          edge.from
        )} ${typeName}了 ${describeUnit(edge.to)}；标签：${relationLabel}`;
        messages.push({
          id: relmsg,
          author: "System",
          createdAt: new Date().toISOString(),
          kind: "relation",
          content,
        });
      }
      continue;
    }

    console.warn("Unknown script line (skipping):", line);
    i++;
  }

  return { messages, edges };
}

/** =========================
 *  Export script v2 (guarantees line-boundary len)
 *  ========================= */

function escapeScriptText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function exportScriptV2(messages: Message[], edges: Edge[]) {
  const lines: string[] = [];

  const normals = messages.filter((m) => m.kind === "normal");
  for (const m of normals) {
    const content = m.content;
    lines.push(
      `MSG id=${m.id} author=${m.author} time=${m.createdAt} len=${content.length}`
    );
    lines.push(content);
    lines.push("END");
  }

  for (const e of edges) {
    lines.push(
      `REL id=${e.id} relmsg=${e.relationMessageId} type=${
        e.relationType
      } label=${escapeScriptText(
        e.relationLabel || relationTypeName(e.relationType)
      )}`
    );
    lines.push(`FROM ${e.from.messageId}`);

    if (e.relationType === "reply") {
      lines.push(`TO   ${e.to.messageId}`);
    } else {
      if (e.to.selection.kind === "whole") {
        lines.push(`TO   ${e.to.messageId}`);
      } else if (e.to.selection.kind === "edge") {
        // Support decoration serialization with @dec: prefix if it's a decoration id
        if ((e.to.selection.edgeId || "").startsWith("dec:")) {
          lines.push(`TO   ${e.to.messageId} "@dec:${e.to.selection.edgeId}"`);
        } else {
          lines.push(`TO   ${e.to.messageId} "@edge:${e.to.selection.edgeId}"`);
        }
      } else {
        const oneLine = e.to.selection.text.replace(/\r?\n/g, "\\n");
        lines.push(
          `TO   ${e.to.messageId} start=${e.to.selection.start} len=${
            e.to.selection.len
          } "${escapeScriptText(oneLine)}"`
        );
      }
    }
    lines.push("END");
  }

  return lines.join("\n");
}

/** =========================
 *  Layout (columns): annotation/reference rule1
 *  ========================= */

type LayoutBox = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

const CARD_W = 320;
const MIN_CARD_H = 86;

const GRID_LEFT = 18;
const GRID_TOP = 18;
const COL_GAP = 28;
const ROW_GAP = 12;
const GLOBAL_ROW_GAP = 12;
const CANVAS_BOTTOM_PAD = 120;

function colX(col: number) {
  return GRID_LEFT + col * (CARD_W + COL_GAP);
}

function computeMinColumnsForAnnoRefRule1(normalIds: string[], edges: Edge[]) {
  const normalSet = new Set(normalIds);

  const relevant = edges.filter(
    (e) =>
      (e.relationType === "annotation" || e.relationType === "reference") &&
      normalSet.has(e.from.messageId) &&
      normalSet.has(e.to.messageId)
  );

  const col: Record<string, number> = {};
  for (const id of normalIds) col[id] = 0;

  let changed = true;
  let iter = 0;
  while (changed && iter < 5000) {
    iter++;
    changed = false;
    for (const e of relevant) {
      const fromId = e.from.messageId;
      const toId = e.to.messageId;
      const need = (col[toId] ?? 0) + 1;
      if ((col[fromId] ?? 0) < need) {
        col[fromId] = need;
        changed = true;
      }
    }
  }

  if (iter >= 5000) {
    console.warn("Anno/Ref cycle suspected; falling back columns to 0.");
    for (const id of normalIds) col[id] = 0;
  }

  const targetsByFrom = new Map<string, string[]>();
  for (const e of relevant) {
    const f = e.from.messageId;
    const t = e.to.messageId;
    const arr = targetsByFrom.get(f) ?? [];
    arr.push(t);
    targetsByFrom.set(f, arr);
  }

  for (const [fromId, toArr] of targetsByFrom) {
    let maxTarget = -Infinity;
    for (const t of toArr) {
      maxTarget = Math.max(maxTarget, col[t] ?? 0);
    }
    const need = maxTarget === -Infinity ? 0 : maxTarget + 1;
    if ((col[fromId] ?? 0) < need) col[fromId] = need;
  }

  const minCol = Math.min(...Object.values(col));
  if (minCol !== 0) {
    for (const id of normalIds) col[id] -= minCol;
  }

  const maxCol = Math.max(...Object.values(col));
  return { col, maxCol };
}

function applyReplyLayoutAdjustmentsWithConstraints(params: {
  normals: Message[];
  edges: Edge[];
  baseCol: Record<string, number>;
  baseMaxCol: number;
}) {
  const { normals, edges, baseCol, baseMaxCol } = params;

  const col: Record<string, number> = { ...baseCol };
  let maxCol = baseMaxCol;

  const normalSet = new Set(normals.map((m) => m.id));
  const msgById = new Map(normals.map((m) => [m.id, m]));

  const minAllowed: Record<string, number> = {};
  for (const m of normals) minAllowed[m.id] = baseCol[m.id] ?? 0;
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference"))
      continue;
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId))
      continue;
    const need = (col[e.to.messageId] ?? 0) + 1;
    minAllowed[e.from.messageId] = Math.max(
      minAllowed[e.from.messageId] ?? 0,
      need
    );
  }

  const replyEdges = edges.filter((e) => e.relationType === "reply");
  const replyTargetsByFrom = new Map<string, string[]>();
  for (const e of replyEdges) {
    if (!normalSet.has(e.from.messageId) || !normalSet.has(e.to.messageId))
      continue;
    if (!replyTargetsByFrom.has(e.from.messageId))
      replyTargetsByFrom.set(e.from.messageId, []);
    replyTargetsByFrom.get(e.from.messageId)!.push(e.to.messageId);
  }

  function mode(nums: number[]) {
    const cnt = new Map<number, number>();
    for (const n of nums) cnt.set(n, (cnt.get(n) ?? 0) + 1);
    let best = nums[0] ?? 0;
    let bestC = -1;
    for (const [k, c] of cnt) {
      if (c > bestC || (c === bestC && k < best)) {
        best = k;
        bestC = c;
      }
    }
    return best;
  }

  const byAuthor = new Map<string, number[]>();
  for (const m of normals) {
    const b = baseCol[m.id] ?? 0;
    const arr = byAuthor.get(m.author) ?? [];
    arr.push(b);
    byAuthor.set(m.author, arr);
  }
  const authorAnchor: Record<string, number> = {};
  for (const [author, colsArr] of byAuthor)
    authorAnchor[author] = mode(colsArr);

  const authorPrevLane: Record<string, number | null> = {};
  for (const a of Object.keys(authorAnchor)) authorPrevLane[a] = null;

  const replyFromIds = Array.from(replyTargetsByFrom.keys());
  replyFromIds.sort((a, b) => {
    const ma = msgById.get(a);
    const mb = msgById.get(b);
    const ta = ma ? new Date(ma.createdAt).getTime() : 0;
    const tb = mb ? new Date(mb.createdAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });

  function better(a: any, b: any) {
    if (!b) return true;
    if (!a) return false;
    const keys = ["incMax", "maxDist", "sumDist", "inLane", "stable", "c"];
    for (const k of keys) {
      if (a[k] < b[k]) return true;
      if (a[k] > b[k]) return false;
    }
    return false;
  }

  for (const fromId of replyFromIds) {
    const fromMsg = msgById.get(fromId);
    if (!fromMsg) continue;

    const targets = replyTargetsByFrom.get(fromId) ?? [];
    const targetCols = targets
      .filter((t) => normalSet.has(t))
      .map((t) => col[t] ?? baseCol[t] ?? 0);
    const forbidden = new Set<number>(targetCols);

    const baseMin = minAllowed[fromId] ?? baseCol[fromId] ?? 0;
    const anchor = authorAnchor[fromMsg.author] ?? baseMin;
    const prevLane = authorPrevLane[fromMsg.author] ?? null;

    const candidates: number[] = [];
    const laneA = Math.max(baseMin, anchor);
    const laneB = Math.max(baseMin, anchor + 1);

    if (prevLane !== null) candidates.push(Math.max(baseMin, prevLane));
    candidates.push(laneA, laneB);

    if (targetCols.length > 0) {
      const sortedT = [...targetCols].sort((a, b) => a - b);
      const med = sortedT[Math.floor(sortedT.length / 2)];
      candidates.push(
        Math.max(baseMin, med),
        Math.max(baseMin, med + 1),
        Math.max(baseMin, med - 1)
      );
    }

    for (let d = 0; d <= 6; d++) {
      candidates.push(
        Math.max(baseMin, anchor - d),
        Math.max(baseMin, anchor + d),
        baseMin + d
      );
    }

    const uniq: number[] = [];
    const seen = new Set<number>();
    for (const c0 of candidates) {
      const c = Math.max(baseMin, c0);
      if (seen.has(c)) continue;
      seen.add(c);
      uniq.push(c);
    }

    const scoreCandidate = (c: number) => {
      if (c < baseMin) return null;
      if (forbidden.has(c)) return null;

      const maxDist =
        targetCols.length === 0
          ? 0
          : Math.max(...targetCols.map((a) => Math.abs(c - a)));
      const sumDist = targetCols.reduce((s, t) => s + Math.abs(c - t), 0);
      const inLane = c === anchor || c === anchor + 1 ? 0 : 1;
      const stable = prevLane !== null && c === prevLane ? 0 : 1;
      const incMax = c > maxCol ? c - maxCol : 0;

      return { incMax, maxDist, sumDist, inLane, stable, c };
    };

    let bestScore: any = null;
    let bestC: number | null = null;

    for (const c of uniq) {
      const sc = scoreCandidate(c);
      if (sc && better(sc, bestScore)) {
        bestScore = sc;
        bestC = c;
      }
    }

    if (bestC === null) {
      let c = Math.max(baseMin, maxCol + 1);
      while (forbidden.has(c)) c += 1;
      bestC = c;
    }

    col[fromId] = bestC;
    maxCol = Math.max(maxCol, bestC);
    authorPrevLane[fromMsg.author] = bestC;
  }

  return { col, maxCol };
}

/** =========================
 *  Layout (y placement)
 *  ========================= */

function computeNoOverlapLayout(params: {
  normals: Message[];
  colOf: Record<string, number>;
  measuredHeights: Record<string, number>;
  maxCol: number;
}) {
  const { normals, colOf, measuredHeights, maxCol } = params;

  const byCol = new Map<number, Message[]>();
  for (const m of normals) {
    const c = colOf[m.id] ?? 0;
    const arr = byCol.get(c) ?? [];
    arr.push(m);
    byCol.set(c, arr);
  }

  for (const [c, arr] of byCol) {
    arr.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  const colCursor: Record<number, number> = {};
  for (let c = 0; c <= maxCol; c++) colCursor[c] = GRID_TOP;

  const layout: Record<string, LayoutBox> = {};
  let maxBottom = GRID_TOP;

  for (let c = 0; c <= maxCol; c++) {
    const arr = byCol.get(c) ?? [];
    for (const m of arr) {
      const h = Math.max(MIN_CARD_H, measuredHeights[m.id] ?? MIN_CARD_H);
      const y = colCursor[c];
      const x = colX(c);

      layout[m.id] = { x, y, width: CARD_W, height: h };

      const bottom = y + h;
      if (bottom > maxBottom) maxBottom = bottom;

      colCursor[c] = bottom + ROW_GAP;
    }
  }

  return { layout, canvasHeight: maxBottom + CANVAS_BOTTOM_PAD };
}

/** =========================
 *  Fragment helpers
 *  ========================= */

function extractTextTargetsForMessage(messageId: string, edges: Edge[]) {
  const res: {
    start: number;
    len: number;
    relationType: RelationType;
    edgeId: string;
  }[] = [];
  for (const e of edges) {
    if (!(e.relationType === "annotation" || e.relationType === "reference"))
      continue;
    if (e.to.messageId !== messageId) continue;
    if (!selectionIsText(e.to.selection)) continue;
    res.push({
      start: e.to.selection.start,
      len: e.to.selection.len,
      relationType: e.relationType,
      edgeId: e.id,
    });
  }
  res.sort(
    (a, b) =>
      a.start - b.start || a.len - b.len || a.edgeId.localeCompare(b.edgeId)
  );
  return res;
}

function clearBrowserSelection() {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

function getRangeStartOffsetUTF16(
  container: HTMLElement,
  range: Range
): number {
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function getSelectionFragment(
  container: HTMLElement
): { start: number; len: number; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;

  const common = range.commonAncestorContainer;
  if (!(common instanceof Node)) return null;
  if (!container.contains(common)) return null;

  const raw = sel.toString();
  if (raw.trim().length === 0) return null;

  const rawStart = getRangeStartOffsetUTF16(container, range);
  const rawLen = raw.length;

  return { start: rawStart, len: rawLen, text: raw };
}

/** =========================
 *  Edge geometry + label placement
 *  ========================= */

function quadAt(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function rayRectIntersectionFirst(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  box: Rect,
  eps = 1e-9
): Point | null {
  const candidates: { t: number; x: number; y: number }[] = [];

  if (Math.abs(dx) > eps) {
    const tx1 = (box.x - ox) / dx;
    const yx1 = oy + tx1 * dy;
    if (tx1 > eps && yx1 >= box.y - 1e-6 && yx1 <= box.y + box.height + 1e-6) {
      candidates.push({ t: tx1, x: box.x, y: yx1 });
    }
    const tx2 = (box.x + box.width - ox) / dx;
    const yx2 = oy + tx2 * dy;
    if (tx2 > eps && yx2 >= box.y - 1e-6 && yx2 <= box.y + box.height + 1e-6) {
      candidates.push({ t: tx2, x: box.x + box.width, y: yx2 });
    }
  }

  if (Math.abs(dy) > eps) {
    const ty1 = (box.y - oy) / dy;
    const xt1 = ox + ty1 * dx;
    if (ty1 > eps && xt1 >= box.x - 1e-6 && xt1 <= box.x + box.width + 1e-6) {
      candidates.push({ t: ty1, x: xt1, y: box.y });
    }
    const ty2 = (box.y + box.height - oy) / dy;
    const xt2 = ox + ty2 * dx;
    if (ty2 > eps && xt2 >= box.x - 1e-6 && xt2 <= box.x + box.width + 1e-6) {
      candidates.push({ t: ty2, x: xt2, y: box.y + box.height });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.t - b.t);
  const c = candidates[0];
  return { x: c.x, y: c.y };
}

function samplePerimeterCandidates(box: Rect) {
  const res: Point[] = [];
  // More systematic sampling along four edges (including corners)
  const samplesPerEdge = 8;
  for (let i = 0; i <= samplesPerEdge; i++) {
    const t = i / samplesPerEdge;
    // top edge
    res.push({ x: box.x + box.width * t, y: box.y });
    // right edge
    res.push({ x: box.x + box.width, y: box.y + box.height * t });
    // bottom edge
    res.push({ x: box.x + box.width * (1 - t), y: box.y + box.height });
    // left edge
    res.push({ x: box.x, y: box.y + box.height * (1 - t) });
  }
  // ensure corners
  res.push({ x: box.x, y: box.y });
  res.push({ x: box.x + box.width, y: box.y });
  res.push({ x: box.x + box.width, y: box.y + box.height });
  res.push({ x: box.x, y: box.y + box.height });
  return res;
}

function rectsIntersect(a: Rect, b: Rect) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function labelRectApprox(x: number, y: number, text: string) {
  const charW = 6.2;
  const w = Math.max(30, text.length * charW) + 10;
  const h = 14;
  return { x: x - w / 2, y: y - h / 2, width: w, height: h };
}

type LabelSeed = {
  drawId: string;
  text: string;
  p0: Point;
  p1: Point;
  p2: Point;
};

function computeLabelPlacementsAlongCurve(params: {
  seeds: LabelSeed[];
  forbiddenRects: Rect[];
}) {
  const { seeds, forbiddenRects } = params;

  const sorted = [...seeds].sort((a, b) => {
    const pa = quadAt(a.p0, a.p1, a.p2, 0.5);
    const pb = quadAt(b.p0, b.p1, b.p2, 0.5);
    return pa.y - pb.y || pa.x - pb.x || a.drawId.localeCompare(b.drawId);
  });

  const placements: Record<string, { x: number; y: number }> = {};
  const placedLabelRects: Rect[] = [];

  const ts = [0.35, 0.42, 0.5, 0.58, 0.65, 0.28, 0.72, 0.2, 0.8];

  for (const s of sorted) {
    let chosen: { x: number; y: number } | null = null;

    // Try candidate t values with small offsets along normal if needed
    for (const t of ts) {
      const p = quadAt(s.p0, s.p1, s.p2, t);
      const r = labelRectApprox(p.x, p.y, s.text);

      let ok = true;
      for (const tr of forbiddenRects) {
        if (rectsIntersect(r, tr)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const lr of placedLabelRects) {
        if (rectsIntersect(r, lr)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      chosen = { x: p.x, y: p.y };
      placedLabelRects.push(r);
      break;
    }

    if (!chosen) {
      // fallback: try expanding along vertical direction from curve midpoint
      const p = quadAt(s.p0, s.p1, s.p2, 0.5);
      let x = p.x;
      let y = p.y;

      let r = labelRectApprox(x, y, s.text);
      let iter = 0;
      while (iter < 200) {
        iter++;
        let collision = false;
        for (const tr of forbiddenRects) {
          if (rectsIntersect(r, tr)) {
            collision = true;
            break;
          }
        }
        for (const lr of placedLabelRects) {
          if (rectsIntersect(r, lr)) {
            collision = true;
            break;
          }
        }
        if (!collision) break;
        // alternate shifting down and up to find space
        const shift = Math.ceil(iter / 2) * 16 * (iter % 2 === 0 ? 1 : -1);
        y = p.y + shift;
        r = labelRectApprox(x, y, s.text);
      }
      chosen = { x, y };
      placedLabelRects.push(r);
    }

    placements[s.drawId] = chosen;
  }

  return placements;
}

/** =========================
 *  GraphView
 *  ========================= */

type LabelBbox = { x: number; y: number; width: number; height: number };

type PositionedEdge = {
  drawId: string;
  edge: Edge;
  fromAuthor: string;
  fromBox: LayoutBox;
  toBox: LayoutBox;
  fromCol: number;
  toCol: number;
  fragRectCanvas: DOMRect | null;
  edgeLabelText: string;
  expandedToEdgeId: string | null;
  labelX: number;
  labelY: number;
  start: Point;
  ctrl: Point;
  end: Point;
};

function GraphView(props: {
  messages: Message[];
  edges: Edge[];
  draftUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
  voteStats: Record<
    string,
    {
      agreeCount: number;
      disagreeCount: number;
      agreeKey: string;
      disagreeKey: string;
    }
  >;

  onMessageClick: (e: React.MouseEvent, messageId: string) => void;
  onMessageDoubleClick: (e: React.MouseEvent, messageId: string) => void;
  onTextMouseUp: (e: React.MouseEvent, messageId: string) => void;

  onEdgeLabelSingleClick: (
    e: React.MouseEvent,
    relationMessageId: string,
    edgeId: string
  ) => void;
  onEdgeLabelDoubleClick: (
    e: React.MouseEvent,
    relationMessageId: string
  ) => void;

  onFragmentAnchorClick: (
    messageId: string,
    start: number,
    len: number,
    text: string
  ) => void;
  isFragmentSelected: (
    messageId: string,
    start: number,
    len: number,
    text: string
  ) => boolean;

  onCanvasBlankClick?: () => void;

  // NEW: mouse down/up handlers to detect drags vs clicks
  onMessageMouseDown?: (e: React.MouseEvent, messageId: string) => void;
  onMessageMouseUp?: (e: React.MouseEvent, messageId: string) => void;

  // Decoration click handler (when user clicks decoration small card)
  onDecorationClick?: (messageId: string, kind: "agree" | "disagree") => void;
}) {
  const {
    messages,
    edges,
    draftUnits,
    activeTextSelectId,
    lastClickedMessageId,
    onMessageClick,
    onMessageDoubleClick,
    onTextMouseUp,
    onEdgeLabelSingleClick,
    onEdgeLabelDoubleClick,
    onFragmentAnchorClick,
    isFragmentSelected,
    onCanvasBlankClick,
    onMessageMouseDown,
    onMessageMouseUp,
    onDecorationClick,
    voteStats,
  } = props;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const contentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const headerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const textRefs = useRef<Record<string, SVGTextElement | null>>({});

  const msgMap = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages]
  );
  const normals = useMemo(
    () => messages.filter((m) => m.kind === "normal"),
    [messages]
  );
  const normalIds = useMemo(() => normals.map((m) => m.id), [normals]);

  const { col: baseCol, maxCol: baseMaxCol } = useMemo(
    () => computeMinColumnsForAnnoRefRule1(normalIds, edges),
    [normalIds, edges]
  );

  const { col: colOf, maxCol } = useMemo(
    () =>
      applyReplyLayoutAdjustmentsWithConstraints({
        normals,
        edges,
        baseCol,
        baseMaxCol,
      }),
    [normals, edges, baseCol, baseMaxCol]
  );

  const [measuredHeights, setMeasuredHeights] = useState<
    Record<string, number>
  >({});
  const [layout, setLayout] = useState<Record<string, LayoutBox>>({});
  const [canvasHeight, setCanvasHeight] = useState<number>(900);

  const [positionedEdges, setPositionedEdges] = useState<PositionedEdge[]>([]);
  const [labelBboxes, setLabelBboxes] = useState<Record<string, LabelBbox>>({});

  // Decoration state for rendering overlay elements
  const [decorationRectsState, setDecorationRectsState] = useState<Record<
    string,
    { kind: "agree" | "disagree"; rect: Rect; key: string; messageId: string }
  > | null>(null);
  const [decorationsByMsgState, setDecorationsByMsgState] = useState<Record<
    string,
    {
      agreeCount: number;
      disagreeCount: number;
      agreeKey: string;
      disagreeKey: string;
    }
  > | null>(null);

  const canvasWidth = GRID_LEFT * 2 + (maxCol + 1) * CARD_W + maxCol * COL_GAP;

  const edgesByRelMsg = useMemo(() => {
    const map = new Map<string, Edge[]>();
    for (const e of edges) {
      const arr = map.get(e.relationMessageId) ?? [];
      arr.push(e);
      map.set(e.relationMessageId, arr);
    }
    return map;
  }, [edges]);

  // ResizeObserver: measure card heights reliably
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const next: Record<string, number> = {};
      for (const ent of entries) {
        const el = ent.target as HTMLElement;
        const id = el.getAttribute("data-msgid");
        if (!id) continue;
        next[id] = Math.ceil(el.getBoundingClientRect().height);
      }
      if (Object.keys(next).length === 0) return;

      setMeasuredHeights((prev) => {
        let changed = false;
        const merged = { ...prev };
        for (const [k, v] of Object.entries(next)) {
          if (!merged[k] || Math.abs(merged[k] - v) > 1) {
            merged[k] = v;
            changed = true;
          }
        }
        return changed ? merged : prev;
      });
    });

    for (const m of normals) {
      const el = cardRefs.current[m.id];
      if (el) ro.observe(el);
    }

    return () => ro.disconnect();
  }, [normals]);

  // y-layout
  useEffect(() => {
    const { layout: nextLayout, canvasHeight: h } = computeNoOverlapLayout({
      normals,
      colOf,
      measuredHeights,
      maxCol,
    });
    setLayout(nextLayout);
    setCanvasHeight(h);
  }, [normals, colOf, maxCol, measuredHeights]);

  // edge + label recompute (also decorations)
  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const normalSet = new Set(normalIds);

    // Prefer DOM card bounding rects (canvas-local coords) for endpoints.
    function endpointBoxForNormal(
      id: string
    ): { box: LayoutBox; col: number } | null {
      const m = msgMap.get(id);
      if (!m || m.kind !== "normal") return null;
      // Prefer actual DOM rect (card element) to ensure visual border alignment
      const cardEl = cardRefs.current[id];
      if (cardEl) {
        const r = cardEl.getBoundingClientRect();
        return {
          box: {
            x: r.left - canvasRect.left,
            y: r.top - canvasRect.top,
            width: r.width,
            height: r.height,
          },
          col: colOf[id] ?? 0,
        };
      }
      // Fallback to layout if DOM not available
      const box = layout[id];
      if (!box) return null;
      return { box, col: colOf[id] ?? 0 };
    }

    // Build global forbidden rects for label avoidance (all headers & contents)
    const globalForbiddenRects: Rect[] = [];
    for (const m of normals) {
      const header = headerRefs.current[m.id];
      const content = contentRefs.current[m.id];
      if (!header || !content) {
        // still attempt to include card rect if available
        const cardEl = cardRefs.current[m.id];
        if (cardEl) {
          for (const r of Array.from(cardEl.getClientRects())) {
            globalForbiddenRects.push({
              x: r.left - canvasRect.left,
              y: r.top - canvasRect.top,
              width: r.width,
              height: r.height,
            });
          }
        }
        continue;
      }

      for (const r of Array.from(header.getClientRects())) {
        globalForbiddenRects.push({
          x: r.left - canvasRect.left,
          y: r.top - canvasRect.top,
          width: r.width,
          height: r.height,
        });
      }
      for (const r of Array.from(content.getClientRects())) {
        globalForbiddenRects.push({
          x: r.left - canvasRect.left,
          y: r.top - canvasRect.top,
          width: r.width,
          height: r.height,
        });
      }
    }

    // Helpers for connected forbidden rects (per message)
    function getMessageRects(messageId: string): Rect[] {
      const res: Rect[] = [];
      const header = headerRefs.current[messageId];
      const content = contentRefs.current[messageId];
      if (header) {
        for (const r of Array.from(header.getClientRects())) {
          res.push({
            x: r.left - canvasRect.left,
            y: r.top - canvasRect.top,
            width: r.width,
            height: r.height,
          });
        }
      }
      if (content) {
        for (const r of Array.from(content.getClientRects())) {
          res.push({
            x: r.left - canvasRect.left,
            y: r.top - canvasRect.top,
            width: r.width,
            height: r.height,
          });
        }
      }
      // Also include whole card rect from card DOM if available (preferred) else layout box (covers margins)
      const cardEl = cardRefs.current[messageId];
      if (cardEl) {
        for (const r of Array.from(cardEl.getClientRects())) {
          res.push({
            x: r.left - canvasRect.left,
            y: r.top - canvasRect.top,
            width: r.width,
            height: r.height,
          });
        }
      } else {
        const l = layout[messageId];
        if (l) res.push({ x: l.x, y: l.y, width: l.width, height: l.height });
      }
      return res;
    }

    function pointInsideRectStrict(p: Point, r: Rect) {
      const eps = 1e-6;
      return (
        p.x > r.x + eps &&
        p.x < r.x + r.width - eps &&
        p.y > r.y + eps &&
        p.y < r.y + r.height - eps
      );
    }

    // Curve sampling helpers (used to detect overlap of quad with rects)
    function sampleQuadPoints(p0: Point, p1: Point, p2: Point, n = 40) {
      const pts: Point[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(quadAt(p0, p1, p2, t));
      }
      return pts;
    }

    function curveIntersectsRects(samples: Point[], rects: Rect[]) {
      for (const p of samples) {
        for (const r of rects) {
          if (pointInsideRectStrict(p, r)) return true;
        }
      }
      return false;
    }

    // Score how much a curve penetrates forbidden rects (count of sample points inside)
    function curvePenetrationScore(samples: Point[], rects: Rect[]) {
      let cnt = 0;
      for (const p of samples) {
        for (const r of rects) {
          if (pointInsideRectStrict(p, r)) {
            cnt++;
            break;
          }
        }
      }
      return cnt;
    }

    // --- Decorations calculation (counts & rects)
    const decorationsByMsg: Record<
      string,
      {
        agreeCount: number;
        disagreeCount: number;
        agreeKey: string;
        disagreeKey: string;
      }
    > = {};
    // Count contributions from agree/disagree votes and support/rebut edges:
    for (const e of edges) {
      // If edge points to a decoration (edge kind) like dec:agree:msg-123
      if (e.to.selection.kind === "edge") {
        const eid = e.to.selection.edgeId || "";
        // Accept either 'dec:agree:msg-123' or 'agree' style? We standardize on dec:*
        if (eid.startsWith("dec:")) {
          const parts = eid.split(":"); // ["dec","agree","msg-123"]
          if (parts.length >= 3) {
            const kind = parts[1];
            const mid = parts.slice(2).join(":");
            if (!decorationsByMsg[mid])
              decorationsByMsg[mid] = {
                agreeCount: 0,
                disagreeCount: 0,
                agreeKey: `dec:agree:${mid}`,
                disagreeKey: `dec:disagree:${mid}`,
              };
            if (e.relationType === "support") {
              // support increments agree decoration
              decorationsByMsg[mid].agreeCount++;
            } else if (e.relationType === "rebut") {
              // rebut increments disagree decoration
              decorationsByMsg[mid].disagreeCount++;
            } else if (e.relationType === "agree") {
              decorationsByMsg[mid].agreeCount++;
            } else if (e.relationType === "disagree") {
              decorationsByMsg[mid].disagreeCount++;
            }
          }
        }
      } else if (e.to.selection.kind === "whole") {
        const mid = e.to.messageId;
        if (!decorationsByMsg[mid])
          decorationsByMsg[mid] = {
            agreeCount: 0,
            disagreeCount: 0,
            agreeKey: `dec:agree:${mid}`,
            disagreeKey: `dec:disagree:${mid}`,
          };
        if (e.relationType === "agree") decorationsByMsg[mid].agreeCount++;
        else if (e.relationType === "disagree")
          decorationsByMsg[mid].disagreeCount++;
        // Note: support/rebut targeted to whole (rare) are not counted unless they target dec explicitly
      }
    }

    // Build decoration rects (placed under the message card)
    const decorationRects: Record<
      string,
      { kind: "agree" | "disagree"; rect: Rect; key: string; messageId: string }
    > = {};
    for (const [mid, data] of Object.entries(decorationsByMsg)) {
      const ep = endpointBoxForNormal(mid);
      const box = ep?.box ?? layout[mid];
      if (!box) continue;
      const decW = 64;
      const decH = 28;
      const gap = 6;
      let offsetY = box.y + box.height + gap;
      if (data.agreeCount > 0) {
        decorationRects[`${mid}::agree`] = {
          kind: "agree",
          key: data.agreeKey,
          messageId: mid,
          rect: {
            x: box.x + (box.width - decW) / 2,
            y: offsetY,
            width: decW,
            height: decH,
          },
        };
        offsetY += decH + 4;
      }
      if (data.disagreeCount > 0) {
        decorationRects[`${mid}::disagree`] = {
          kind: "disagree",
          key: data.disagreeKey,
          messageId: mid,
          rect: {
            x: box.x + (box.width - decW) / 2,
            y: offsetY,
            width: decW,
            height: decH,
          },
        };
        offsetY += decH + 4;
      }
    }

    // Add decoration rects into global forbidden rects so labels avoid them
    for (const v of Object.values(decorationRects)) {
      globalForbiddenRects.push(v.rect);
    }

    // For each rawEdge, compute start/ctrl/end ensuring:
    //  - endpoints lie on corresponding element boundary
    //  - curve does not cover connectedForbiddenRects (source/target messages & fragments)
    //  - label avoidance handled separately with globalForbiddenRects
    const rawEdges: Omit<PositionedEdge, "labelX" | "labelY">[] = [];
    const labelSeeds: LabelSeed[] = [];

    const labelTextForEdge = (e: Edge, fromAuthor: string) =>
      `${fromAuthor} · ${relationTypeName(e.relationType)}`;

    // First pass: build rawEdges (with fragRectCanvas if applicable)
    for (const e of edges) {
      const fromMsg = msgMap.get(e.from.messageId);
      if (!fromMsg || fromMsg.kind !== "normal") continue;

      const fromEp = endpointBoxForNormal(fromMsg.id);
      if (!fromEp) continue;

      const fromAuthor = fromMsg.author;

      const toMsg = msgMap.get(e.to.messageId);
      const toIsRelation = !!toMsg && toMsg.kind === "relation";

      if (toIsRelation) {
        const relId = e.to.messageId;

        const expand = (te: Edge) => {
          const teToMsg = msgMap.get(te.to.messageId);

          const endpointForTarget =
            teToMsg?.kind === "normal"
              ? endpointBoxForNormal(te.to.messageId)
              : null;
          const fallbackToBox = endpointForTarget?.box ?? fromEp.box;
          const toCol = endpointForTarget?.col ?? fromEp.col;

          const drawId = `${e.id}__toRel__${te.id}`;
          const edgeLabelText = labelTextForEdge(e, fromAuthor);

          rawEdges.push({
            drawId,
            edge: e,
            fromAuthor,
            fromBox: fromEp.box,
            toBox: fallbackToBox,
            fromCol: fromEp.col,
            toCol,
            fragRectCanvas: null,
            edgeLabelText,
            expandedToEdgeId: te.id,
            start: { x: 0, y: 0 },
            ctrl: { x: 0, y: 0 },
            end: { x: 0, y: 0 },
          });
        };

        if (e.to.selection.kind === "edge") {
          const fragmentEdgeId = e.to.selection.edgeId;
          const targetEdges = (edgesByRelMsg.get(relId) ?? []).filter(
            (x) => x.id === fragmentEdgeId
          );
          targetEdges.forEach(expand);
        } else if (e.to.selection.kind === "whole") {
          const targetEdges = edgesByRelMsg.get(relId) ?? [];
          targetEdges.forEach(expand);
        }

        continue;
      }

      const toId = e.to.messageId;
      if (!normalSet.has(toId)) continue;

      const toEp = endpointBoxForNormal(toId);
      if (!toEp) continue;

      let fragRectCanvas: DOMRect | null = null;

      // If edge targets a decoration explicitly (dec:...), prefer the decoration rect
      if (e.to.selection.kind === "edge") {
        const eid = e.to.selection.edgeId || "";
        if (eid.startsWith("dec:")) {
          const parts = eid.split(":");
          if (parts.length >= 3) {
            const kind = parts[1]; // agree | disagree
            const mid = parts.slice(2).join(":");
            const key = `${mid}::${kind}`;
            const dec = decorationRects[key];
            if (dec) {
              const r = dec.rect;
              // Use a DOMRect-like object
              fragRectCanvas = new DOMRect(r.x, r.y, r.width, r.height);
            }
          }
        }
      }

      if (
        (e.relationType === "annotation" || e.relationType === "reference") &&
        selectionIsText(e.to.selection) &&
        contentRefs.current[toId]
      ) {
        const container = contentRefs.current[toId]!;
        const start = e.to.selection.start;
        const end = e.to.selection.start + e.to.selection.len;
        const sel = `[data-rel-anchor="${e.relationType}::${start}:${end}"]`;
        const span = container.querySelector(sel) as HTMLSpanElement | null;
        if (span) {
          const r = span.getBoundingClientRect();
          fragRectCanvas = new DOMRect(
            r.left - canvasRect.left,
            r.top - canvasRect.top,
            r.width,
            r.height
          );
        }
      }

      rawEdges.push({
        drawId: e.id,
        edge: e,
        fromAuthor,
        fromBox: fromEp.box,
        toBox: toEp.box,
        fromCol: fromEp.col,
        toCol: toEp.col,
        fragRectCanvas,
        edgeLabelText: labelTextForEdge(e, fromAuthor),
        expandedToEdgeId: null,
        start: { x: 0, y: 0 },
        ctrl: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      });
    }

    // For each rawEdge, compute start/ctrl/end ensuring constraints (same as before)
    for (let idx = 0; idx < rawEdges.length; idx++) {
      const pe = rawEdges[idx];
      const { fromBox, toBox, fromCol, toCol, fragRectCanvas, edge } = pe;

      const fromCenter = {
        x: fromBox.x + fromBox.width / 2,
        y: fromBox.y + fromBox.height / 2,
      };

      const toRect: Rect = fragRectCanvas
        ? {
            x: fragRectCanvas.x,
            y: fragRectCanvas.y,
            width: fragRectCanvas.width,
            height: fragRectCanvas.height,
          }
        : { x: toBox.x, y: toBox.y, width: toBox.width, height: toBox.height };

      const toCenter = {
        x: toRect.x + toRect.width / 2,
        y: toRect.y + toRect.height / 2,
      };

      const vTo = {
        x: toCenter.x - fromCenter.x,
        y: toCenter.y - fromCenter.y,
      };
      const vFrom = {
        x: fromCenter.x - toCenter.x,
        y: fromCenter.y - toCenter.y,
      };

      // Determine candidate endpoints (snap to boundary / perimeter samples)
      // Primary attempt: ray intersection from centers
      let startPrimary: Point | null = null;
      if (Math.abs(vTo.x) > 1e-12 || Math.abs(vTo.y) > 1e-12) {
        const s = rayRectIntersectionFirst(
          fromCenter.x,
          fromCenter.y,
          vTo.x,
          vTo.y,
          fromBox
        );
        if (s) startPrimary = s;
      }
      let endPrimary: Point | null = null;
      if (Math.abs(vFrom.x) > 1e-12 || Math.abs(vFrom.y) > 1e-12) {
        const ept = rayRectIntersectionFirst(
          toCenter.x,
          toCenter.y,
          vFrom.x,
          vFrom.y,
          toRect
        );
        if (ept) endPrimary = ept;
      }

      // Fallback to perimeter sample near direction
      function chooseBestCandidateOnBox(
        box: Rect,
        preferDir: Point,
        preferFromCenter: Point
      ) {
        const candidates = samplePerimeterCandidates(box);
        let best: { p: Point; score: number } | null = null;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        for (const c of candidates) {
          const dv = { x: c.x - cx, y: c.y - cy };
          const ang1 = Math.atan2(dv.y, dv.x);
          const ang2 = Math.atan2(preferDir.y, preferDir.x);
          let diff = Math.abs(ang1 - ang2);
          if (diff > Math.PI) diff = 2 * Math.PI - diff;
          const score = diff;
          if (!best || score < best.score) best = { p: c, score };
        }
        return best ? best.p : null;
      }

      if (!startPrimary) {
        const cand = chooseBestCandidateOnBox(fromBox, vTo, fromCenter);
        if (cand) startPrimary = cand;
        else {
          const cx = fromBox.x + fromBox.width / 2;
          const cy = fromBox.y + fromBox.height / 2;
          if (Math.abs(vTo.x) > Math.abs(vTo.y)) {
            startPrimary = {
              x: vTo.x > 0 ? fromBox.x + fromBox.width : fromBox.x,
              y: cy,
            };
          } else {
            startPrimary = {
              x: cx,
              y: vTo.y > 0 ? fromBox.y + fromBox.height : fromBox.y,
            };
          }
        }
      }

      if (!endPrimary) {
        const cand = chooseBestCandidateOnBox(toRect, vFrom, toCenter);
        if (cand) endPrimary = cand;
        else {
          const cx = toRect.x + toRect.width / 2;
          const cy = toRect.y + toRect.height / 2;
          if (Math.abs(vFrom.x) > Math.abs(vFrom.y)) {
            endPrimary = {
              x: vFrom.x > 0 ? toRect.x + toRect.width : toRect.x,
              y: cy,
            };
          } else {
            endPrimary = {
              x: cx,
              y: vFrom.y > 0 ? toRect.y + toRect.height : toRect.y,
            };
          }
        }
      }

      // Prepare candidate sets
      const startCandidates: Point[] = [];
      const endCandidates: Point[] = [];

      // include primary
      if (startPrimary) startCandidates.push(startPrimary);
      if (endPrimary) endCandidates.push(endPrimary);

      // add a few perimeter samples near primary
      const fromPerims = samplePerimeterCandidates(fromBox);
      for (const p of fromPerims.slice(0, 12)) startCandidates.push(p);
      const toPerims = samplePerimeterCandidates(toRect);
      for (const p of toPerims.slice(0, 12)) endCandidates.push(p);

      // unique reduce
      function uniqPoints(arr: Point[]) {
        const seen = new Set<string>();
        const res: Point[] = [];
        for (const p of arr) {
          const k = `${Math.round(p.x)},${Math.round(p.y)}`;
          if (!seen.has(k)) {
            seen.add(k);
            res.push(p);
          }
        }
        return res;
      }
      const sCandidates = uniqPoints(startCandidates).slice(0, 24);
      const eCandidates = uniqPoints(endCandidates).slice(0, 24);

      // ctrl candidates: base + offsets (fan + vertical shifts)
      const leftCol = Math.min(fromCol, toCol);
      const rightCol = Math.max(fromCol, toCol);
      const gapLeft = colX(leftCol) + CARD_W;
      const gapRight = colX(rightCol);
      const gapMidX = (gapLeft + gapRight) / 2;

      const fanBase = (idx - (rawEdges.length - 1) / 2) * 6;
      const ctrlBase = {
        x: gapMidX,
        y: (fromCenter.y + toCenter.y) / 2 + fanBase,
      };
      const ctrlCandidates: Point[] = [];
      ctrlCandidates.push(ctrlBase);
      // add vertical offsets and small x offsets
      const offs = [-120, -80, -40, 0, 40, 80, 120];
      for (const o of offs)
        ctrlCandidates.push({ x: gapMidX + o * 0.5, y: ctrlBase.y + o });
      for (const ox of [-120, -60, -30, 30, 60, 120])
        ctrlCandidates.push({ x: gapMidX + ox, y: ctrlBase.y });

      // connected forbidden rects: only source & target message rects (and fragment rect if exists)
      const connectedForbiddenRects: Rect[] = [];
      const fromRects = getMessageRects(pe.edge.from.messageId);
      const toRects = getMessageRects(pe.edge.to.messageId);
      for (const r of fromRects) connectedForbiddenRects.push(r);
      for (const r of toRects) connectedForbiddenRects.push(r);
      if (pe.fragRectCanvas) {
        connectedForbiddenRects.push({
          x: pe.fragRectCanvas.x,
          y: pe.fragRectCanvas.y,
          width: pe.fragRectCanvas.width,
          height: pe.fragRectCanvas.height,
        });
      }

      // search for a candidate quad that does not intersect connectedForbiddenRects
      let chosenCurve: { s: Point; c: Point; e: Point } | null = null;
      let chosenScore = Infinity;

      const PEN_WEIGHT = 20000;
      const maxTries = 5000; // increased safeguard
      let tries = 0;
      outer: for (const s of sCandidates) {
        for (const ePt of eCandidates) {
          for (const c of ctrlCandidates) {
            tries++;
            if (tries > maxTries) break outer;
            const samples = sampleQuadPoints(s, c, ePt, 36);
            const pen = curvePenetrationScore(samples, connectedForbiddenRects);
            // score prefers zero-penetration, then shorter length
            let len = 0;
            for (let i = 1; i < samples.length; i++) {
              const dx = samples[i].x - samples[i - 1].x;
              const dy = samples[i].y - samples[i - 1].y;
              len += Math.hypot(dx, dy);
            }
            const score = pen * PEN_WEIGHT + len;
            if (pen === 0) {
              // prefer first zero-pen solution of reasonable length
              chosenCurve = { s, c, e: ePt };
              chosenScore = score;
              break outer;
            } else {
              if (score < chosenScore) {
                chosenScore = score;
                chosenCurve = { s, c, e: ePt };
              }
            }
          }
        }
      }

      // fallback: if nothing found due to tries limit or other, chosenCurve may be non-null as best-scored
      if (!chosenCurve) {
        // As ultimate fallback, produce a straightforward quad from primary endpoints and base ctrl
        chosenCurve = {
          s: startPrimary ?? { x: fromCenter.x, y: fromCenter.y },
          c: ctrlBase,
          e: endPrimary ?? { x: toCenter.x, y: toCenter.y },
        };
      }

      // snap chosen endpoints strictly to box boundaries to be safe
      function snapToBoundaryStrict(box: Rect, p: Point): Point {
        const eps = 1e-6;
        let x = p.x;
        let y = p.y;

        if (Math.abs(x - box.x) < 1e-5) x = box.x;
        if (Math.abs(x - (box.x + box.width)) < 1e-5) x = box.x + box.width;
        if (Math.abs(y - box.y) < 1e-5) y = box.y;
        if (Math.abs(y - (box.y + box.height)) < 1e-5) y = box.y + box.height;

        const inside =
          x > box.x + eps &&
          x < box.x + box.width - eps &&
          y > box.y + eps &&
          y < box.y + box.height - eps;

        if (inside) {
          const dLeft = Math.abs(p.x - box.x);
          const dRight = Math.abs(p.x - (box.x + box.width));
          const dTop = Math.abs(p.y - box.y);
          const dBottom = Math.abs(p.y - (box.y + box.height));
          const minD = Math.min(dLeft, dRight, dTop, dBottom);
          if (minD === dLeft) {
            x = box.x;
            y = Math.min(Math.max(p.y, box.y), box.y + box.height);
          } else if (minD === dRight) {
            x = box.x + box.width;
            y = Math.min(Math.max(p.y, box.y), box.y + box.height);
          } else if (minD === dTop) {
            y = box.y;
            x = Math.min(Math.max(p.x, box.x), box.x + box.width);
          } else {
            y = box.y + box.height;
            x = Math.min(Math.max(p.x, box.x), box.x + box.width);
          }
        } else {
          x = Math.min(Math.max(x, box.x), box.x + box.width);
          y = Math.min(Math.max(y, box.y), box.y + box.height);
          if (
            x > box.x + eps &&
            x < box.x + box.width - eps &&
            y > box.y + eps &&
            y < box.y + box.height - eps
          ) {
            const dLeft = Math.abs(p.x - box.x);
            const dRight = Math.abs(p.x - (box.x + box.width));
            const dTop = Math.abs(p.y - box.y);
            const dBottom = Math.abs(p.y - (box.y + box.height));
            const minD = Math.min(dLeft, dRight, dTop, dBottom);
            if (minD === dLeft) {
              x = box.x;
              y = Math.min(Math.max(p.y, box.y), box.y + box.height);
            } else if (minD === dRight) {
              x = box.x + box.width;
              y = Math.min(Math.max(p.y, box.y), box.y + box.height);
            } else if (minD === dTop) {
              y = box.y;
              x = Math.min(Math.max(p.x, box.x), box.x + box.width);
            } else {
              y = box.y + box.height;
              x = Math.min(Math.max(p.x, box.x), box.x + box.width);
            }
          }
        }

        return { x, y };
      }

      const chosenS = snapToBoundaryStrict(fromBox, chosenCurve.s);
      const chosenE = snapToBoundaryStrict(toRect, chosenCurve.e);

      pe.start = chosenS;
      pe.ctrl = chosenCurve.c;
      pe.end = chosenE;

      labelSeeds.push({
        drawId: pe.drawId,
        text: pe.edgeLabelText,
        p0: pe.start,
        p1: pe.ctrl,
        p2: pe.end,
      });
    }

    const placements = computeLabelPlacementsAlongCurve({
      seeds: labelSeeds,
      forbiddenRects: globalForbiddenRects,
    });

    const finalEdges: PositionedEdge[] = rawEdges.map((pe) => {
      const p = placements[pe.drawId] ?? quadAt(pe.start, pe.ctrl, pe.end, 0.5);
      return { ...pe, labelX: p.x, labelY: p.y };
    });

    // Update state: positioned edges and decoration metadata for rendering
    setPositionedEdges(finalEdges);
    setDecorationRectsState(decorationRects);
    setDecorationsByMsgState(decorationsByMsg);
  }, [
    edges,
    msgMap,
    layout,
    colOf,
    normalIds,
    edgesByRelMsg,
    canvasWidth,
    canvasHeight,
    normals,
  ]);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const next: Record<string, LabelBbox> = {};
    for (const pe of positionedEdges) {
      const t = textRefs.current[pe.drawId];
      if (!t) continue;
      const r = t.getBoundingClientRect();
      next[pe.drawId] = {
        x: r.left - canvasRect.left,
        y: r.top - canvasRect.top,
        width: r.width,
        height: r.height,
      };
    }
    setLabelBboxes(next);
  }, [positionedEdges, canvasWidth, canvasHeight]);

  function isEdgeLabelFragmentSelected(
    relationMessageId: string,
    edgeId: string
  ) {
    const u: UnitSelection = {
      messageId: relationMessageId,
      selection: { kind: "edge", edgeId },
    };
    return draftUnits.some((x) => unitEquals(x, u));
  }
  function isRelationWholeSelected(relationMessageId: string) {
    const u: UnitSelection = {
      messageId: relationMessageId,
      selection: { kind: "whole" },
    };
    return draftUnits.some((x) => unitEquals(x, u));
  }

  function renderMessageContentWithAnchorsForGraph(message: Message) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (targets.length === 0) {
      return (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
            fontSize: 13,
          }}
        >
          {message.content}
        </pre>
      );
    }

    const text = message.content;
    const segs: { start: number; end: number; relationType: RelationType }[] =
      [];
    let lastEnd = -1;
    for (const t of targets) {
      const start = t.start;
      const end = t.start + t.len;
      if (start < 0 || end > text.length || t.len <= 0) continue;
      if (start < lastEnd) continue;
      segs.push({ start, end, relationType: t.relationType });
      lastEnd = end;
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    for (const s of segs) {
      if (cursor < s.start)
        nodes.push(
          <span key={`t-${cursor}`} style={{ whiteSpace: "pre-wrap" }}>
            {text.slice(cursor, s.start)}
          </span>
        );

      const frag = text.slice(s.start, s.end);
      const isAnno = s.relationType === "annotation";
      const len = s.end - s.start;
      const selected = isFragmentSelected(message.id, s.start, len, frag);

      nodes.push(
        <span
          key={`h-${s.start}-${s.end}`}
          data-rel-anchor={`${s.relationType}::${s.start}:${s.end}`}
          onClick={(e) => {
            e.stopPropagation();
            onFragmentAnchorClick(message.id, s.start, len, frag);
          }}
          title="点击：进入文本选择状态并切换选中该片段"
          style={{
            whiteSpace: "pre-wrap",
            cursor: "pointer",
            backgroundColor: selected
              ? "rgba(11,132,255,0.18)"
              : isAnno
              ? "rgba(255,255,0,0.12)"
              : "rgba(80,180,255,0.08)",
            outline: selected
              ? "2px solid rgba(11,132,255,0.95)"
              : isAnno
              ? "1px solid rgba(255,255,0,0.8)"
              : "1px solid rgba(80,180,255,0.45)",
            borderRadius: 2,
          }}
        >
          {frag}
        </span>
      );
      cursor = s.end;
    }

    if (cursor < text.length)
      nodes.push(
        <span key={`t-${cursor}`} style={{ whiteSpace: "pre-wrap" }}>
          {text.slice(cursor)}
        </span>
      );

    return (
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
          fontSize: 13,
        }}
      >
        {nodes}
      </pre>
    );
  }

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!canvasRef.current) return;
    if (
      target.closest &&
      (target.closest("[data-msgid]") ||
        target.closest("svg") ||
        target.closest('[title^="relation="]'))
    ) {
      return;
    }
    onCanvasBlankClick?.();
  };

  return (
    <div
      ref={canvasRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseDown={handleCanvasMouseDown}
    >
      <div
        style={{
          position: "relative",
          width: canvasWidth,
          height: canvasHeight,
          zIndex: 2,
        }}
      >
        {normals.map((msg) => {
          const box = layout[msg.id];
          if (!box) return null;

          const isWholeSelected = draftUnits.some(
            (u) => u.messageId === msg.id && u.selection.kind === "whole"
          );
          const isTextMode =
            activeTextSelectId === msg.id && msg.kind === "normal";

          return (
            <div
              key={msg.id}
              data-msgid={msg.id}
              ref={(el) => {
                cardRefs.current[msg.id] = el;
              }}
              onClick={(e) => onMessageClick(e, msg.id)}
              onDoubleClick={(e) => onMessageDoubleClick(e, msg.id)}
              onMouseDown={(e) => onMessageMouseDown?.(e, msg.id)}
              onMouseUp={(e) => onMessageMouseUp?.(e, msg.id)}
              style={{
                position: "absolute",
                left: box.x,
                top: box.y,
                width: box.width,
                background: "#1f1f1f",
                borderRadius: 6,
                border: isTextMode
                  ? "2px dashed #0b84ff"
                  : isWholeSelected
                  ? "2px solid #0b84ff"
                  : "1px solid #444",
                padding: "8px 10px",
                boxShadow: isTextMode
                  ? "0 6px 18px rgba(11,132,255,0.06)"
                  : "0 4px 10px rgba(0,0,0,0.5)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                cursor: "pointer",
                outline:
                  lastClickedMessageId === msg.id
                    ? "1px dashed #0b84ff"
                    : "none",
                userSelect: activeTextSelectId === msg.id ? "text" : "auto",
              }}
            >
              <div
                ref={(el) => {
                  headerRefs.current[msg.id] = el;
                }}
                style={{
                  fontSize: 11,
                  opacity: 0.85,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{msg.author}</span>
                <span style={{ opacity: 0.7 }}>{msg.id}</span>
              </div>

              {isTextMode && (
                <div
                  style={{ fontSize: 11, color: "#0b84ff", marginBottom: 4 }}
                >
                  文本选择模式：拖选记录 start+len；或点击高亮片段
                </div>
              )}

              <div
                ref={(el) => {
                  contentRefs.current[msg.id] = el;
                }}
                style={{ fontSize: 13, color: "#f5f5f5" }}
                onMouseUp={(e) => onTextMouseUp(e, msg.id)}
              >
                {renderMessageContentWithAnchorsForGraph(msg)}
              </div>
            </div>
          );
        })}
      </div>

      {positionedEdges.length > 0 && (
        <>
          <svg
            width={canvasWidth}
            height={canvasHeight}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              zIndex: 3,
              pointerEvents: "none",
            }}
          >
            {positionedEdges.map((pe) => {
              const { edge, start, ctrl, end, edgeLabelText, labelX, labelY } =
                pe;
              const pathD = `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;

              const angle = Math.atan2(end.y - ctrl.y, end.x - ctrl.x);
              const arrowLen = 7;
              const arrowAngle = Math.PI / 7;
              const ax1 = end.x - arrowLen * Math.cos(angle - arrowAngle);
              const ay1 = end.y - arrowLen * Math.sin(angle - arrowAngle);
              const ax2 = end.x - arrowLen * Math.cos(angle + arrowAngle);
              const ay2 = end.y - arrowLen * Math.sin(angle + arrowAngle);

              const color =
                edge.relationType === "annotation"
                  ? "rgba(255,215,0,0.92)"
                  : edge.relationType === "reference"
                  ? "rgba(80,180,255,0.92)"
                  : edge.relationType === "reply"
                  ? "rgba(160,255,140,0.72)"
                  : edge.relationType === "agree"
                  ? "rgba(2,150,80,0.92)"
                  : edge.relationType === "disagree"
                  ? "rgba(200,40,40,0.92)"
                  : edge.relationType === "support"
                  ? "rgba(2,150,80,0.92)"
                  : "rgba(200,40,40,0.92)";

              const relId = edge.relationMessageId;
              const isWhole = isRelationWholeSelected(relId);
              const isFrag = isEdgeLabelFragmentSelected(relId, edge.id);

              const labelOpacity =
                isWhole || isFrag
                  ? 1
                  : edge.relationType === "reply"
                  ? 0.65
                  : 0.9;
              const labelStroke =
                isWhole || isFrag
                  ? "rgba(11,132,255,0.95)"
                  : "rgba(0,0,0,0.85)";
              const labelStrokeW = isWhole || isFrag ? 3 : 2;

              return (
                <g key={pe.drawId}>
                  <path
                    d={pathD}
                    stroke={color}
                    strokeWidth={edge.relationType === "reply" ? 1.0 : 1.2}
                    fill="none"
                  />
                  <path
                    d={`M ${ax1} ${ay1} L ${end.x} ${end.y} L ${ax2} ${ay2}`}
                    fill={color}
                  />
                  <text
                    ref={(el) => {
                      textRefs.current[pe.drawId] = el;
                    }}
                    x={labelX}
                    y={labelY}
                    fill={color}
                    opacity={labelOpacity}
                    fontSize={10}
                    textAnchor="middle"
                    dominantBaseline="central"
                    style={
                      {
                        paintOrder: "stroke",
                        stroke: labelStroke,
                        strokeWidth: labelStrokeW,
                      } as any
                    }
                  >
                    {edgeLabelText}
                  </text>
                </g>
              );
            })}
          </svg>

          {positionedEdges.map((pe) => {
            const bb = labelBboxes[pe.drawId];
            if (!bb) return null;

            const padX = 8;
            const padY = 6;
            const box: LayoutBox = {
              x: bb.x - padX,
              y: bb.y - padY,
              width: bb.width + padX * 2,
              height: bb.height + padY * 2,
            };

            const relId = pe.edge.relationMessageId;
            const isWhole = isRelationWholeSelected(relId);
            const isFrag = isEdgeLabelFragmentSelected(relId, pe.edge.id);

            return (
              <div
                key={`hit-${pe.drawId}`}
                onClick={(e) => onEdgeLabelSingleClick(e, relId, pe.edge.id)}
                onDoubleClick={(e) => onEdgeLabelDoubleClick(e, relId)}
                style={{
                  position: "absolute",
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  zIndex: 4,
                  cursor: "pointer",
                  pointerEvents: "auto",
                  background: "transparent",
                  borderRadius: 6,
                  border:
                    isWhole || isFrag
                      ? "1px solid rgba(11,132,255,0.85)"
                      : "1px solid transparent",
                }}
                title={`relation=${pe.edge.relationMessageId} edge=${pe.edge.id}`}
              />
            );
          })}
        </>
      )}

      {/* Render decorations (small cards) based on decorationRectsState */}
      {decorationRectsState &&
        decorationsByMsgState &&
        Object.entries(decorationRectsState).map(([k, v]) => {
          const mid = v.messageId;
          const counts = decorationsByMsgState[mid];
          if (!counts) return null;
          const cnt =
            v.kind === "agree" ? counts.agreeCount : counts.disagreeCount;
          return (
            <div
              key={`dec-${v.key}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onDecorationClick?.(mid, v.kind);
              }}
              title={`${relationTypeName(v.kind as any)}：点击查看记录`}
              style={{
                position: "absolute",
                left: v.rect.x,
                top: v.rect.y,
                width: v.rect.width,
                height: v.rect.height,
                zIndex: 5,
                background:
                  v.kind === "agree"
                    ? "rgba(2,150,80,0.9)"
                    : "rgba(200,40,40,0.9)",
                color: "#fff",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                pointerEvents: "auto",
                cursor: "pointer",
                boxShadow: "0 4px 10px rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span style={{ fontWeight: 700 }}>{cnt}</span>
            </div>
          );
        })}
    </div>
  );
}

/** =========================
 *  StructureView (supports multiple focus ids)
 *  ========================= */

function StructureView(props: {
  focusIds: string[]; // now array
  messages: Message[];
  edges: Edge[];
}) {
  const { focusIds, messages, edges } = props;
  const msgMap = new Map(messages.map((m) => [m.id, m]));

  if (!focusIds || focusIds.length === 0) {
    return (
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          结构视图（全局模式·简化）
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          （进入焦点后显示：左侧指向我 / 右侧我指向）
        </div>
      </div>
    );
  }

  // For multiple focus ids, render a compact section per focus
  return (
    <div style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        结构视图（焦点模式 · 多焦点）
      </div>

      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
        当前焦点消息：
        {focusIds.map((id, idx) => {
          const m = msgMap.get(id);
          return (
            <span key={id} style={{ marginLeft: idx === 0 ? 4 : 8 }}>
              {m ? `${m.id} · ${m.author}` : id}
            </span>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <div
          style={{
            flex: 1,
            border: "1px solid #333",
            borderRadius: 6,
            padding: 6,
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            左侧（Incoming：指向焦点集合）
          </div>
          <IncomingOutgoingList
            focusIds={focusIds}
            edges={edges}
            kind="in"
            messages={messages}
          />
        </div>

        <div
          style={{
            flex: 1,
            border: "1px solid #333",
            borderRadius: 6,
            padding: 6,
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            右侧（Outgoing：焦点集合指向）
          </div>
          <IncomingOutgoingList
            focusIds={focusIds}
            edges={edges}
            kind="out"
            messages={messages}
          />
        </div>
      </div>
    </div>
  );
}

function IncomingOutgoingList(props: {
  focusIds: string[];
  edges: Edge[];
  kind: "in" | "out";
  messages: Message[];
}) {
  const { focusIds, edges, kind, messages } = props;

  // collect edges per focus
  const rows: { focusId: string; entries: Edge[] }[] = focusIds.map((id) => {
    // If the focus id is a relation message, show edges that belong to that relation
    const m = messages.find((mm) => mm.id === id);
    let arr: Edge[] = [];
    if (m && m.kind === "relation") {
      arr = edges.filter((e) => e.relationMessageId === id);
    } else {
      arr =
        kind === "in"
          ? edges.filter((e) => e.to.messageId === id)
          : edges.filter((e) => e.from.messageId === id);
    }
    return { focusId: id, entries: arr };
  });

  const hasAny = rows.some((r) => r.entries.length > 0);

  if (!hasAny) {
    return <div style={{ fontSize: 12, opacity: 0.6 }}>无</div>;
  }

  return (
    <div style={{ fontSize: 12 }}>
      <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
        {rows.map((r) => (
          <li key={r.focusId} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {r.focusId}
            </div>
            {r.entries.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>无</div>
            ) : (
              <ul style={{ listStyle: "none", paddingLeft: 10, margin: 0 }}>
                {r.entries.map((e) => (
                  <li key={e.id} style={{ marginBottom: 4 }}>
                    {relationTypeName(e.relationType)}：{fmtSel(e.from)} →{" "}
                    {fmtSel(e.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtSel(u: UnitSelection) {
  if (u.selection.kind === "whole") return `${u.messageId}`;
  if (u.selection.kind === "edge")
    return `${u.messageId}(@edge:${u.selection.edgeId})`;
  return `${u.messageId}(start=${u.selection.start},len=${u.selection.len})`;
}

/** =========================
 *  App
 *  ========================= */

type ViewMode = "list" | "graph";

type FocusSnapshot = {
  leftScroll: { top: number; left: number } | null;
  rightScroll: { top: number; left: number } | null;
  draftUnits: UnitSelection[];
  sourceUnits: UnitSelection[];
  targetUnits: UnitSelection[];
  activeTextSelectId: string | null;
  lastClickedMessageId: string | null;
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setLoadError(null);

        const resp = await fetch("/initial_script.txt", { cache: "no-store" });
        if (!resp.ok)
          throw new Error(
            `Failed to fetch /initial_script.txt: ${resp.status} ${resp.statusText}`
          );
        const txt = await resp.text();

        const parsed = parseInitialScriptV2(txt);
        if (cancelled) return;

        setMessages(parsed.messages);
        setEdges(parsed.edges);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(String(e?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const [relationType, setRelationType] = useState<RelationType>("annotation");
  const [secondaryRelationType, setSecondaryRelationType] =
    useState<SecondaryRelationType>("none");

  const [relationLabel, setRelationLabel] = useState("");
  const [newMessageContent, setNewMessageContent] = useState("");

  const [draftUnits, setDraftUnits] = useState<UnitSelection[]>([]);
  const [sourceUnits, setSourceUnits] = useState<UnitSelection[]>([]);
  const [targetUnits, setTargetUnits] = useState<UnitSelection[]>([]);

  const [activeTextSelectId, setActiveTextSelectId] = useState<string | null>(
    null
  );
  // focusEntries: stack of { ids: string[], snapshot }
  const [focusEntries, setFocusEntries] = useState<
    { ids: string[]; snapshot: FocusSnapshot | null }[]
  >([]);
  const [lastClickedMessageId, setLastClickedMessageId] = useState<
    string | null
  >(null);

  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  const [focusHop, setFocusHop] = useState<number>(1);

  // current focus ids (the top entry ids) for display
  const currentFocusIds =
    focusEntries.length > 0 ? focusEntries[focusEntries.length - 1].ids : null;
  const msgMap = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages]
  );

  // compute voteStats (for GraphView prop)
  const voteStats = useMemo(() => {
    const res: Record<
      string,
      {
        agreeCount: number;
        disagreeCount: number;
        agreeKey: string;
        disagreeKey: string;
      }
    > = {};
    for (const e of edges) {
      if (e.to.selection.kind === "edge") {
        const eid = e.to.selection.edgeId || "";
        if (eid.startsWith("dec:")) {
          const parts = eid.split(":");
          if (parts.length >= 3) {
            const kind = parts[1];
            const mid = parts.slice(2).join(":");
            if (!res[mid])
              res[mid] = {
                agreeCount: 0,
                disagreeCount: 0,
                agreeKey: `dec:agree:${mid}`,
                disagreeKey: `dec:disagree:${mid}`,
              };
            if (e.relationType === "support" || e.relationType === "agree")
              res[mid].agreeCount++;
            if (e.relationType === "rebut" || e.relationType === "disagree")
              res[mid].disagreeCount++;
          }
        }
      } else if (e.to.selection.kind === "whole") {
        const mid = e.to.messageId;
        if (!res[mid])
          res[mid] = {
            agreeCount: 0,
            disagreeCount: 0,
            agreeKey: `dec:agree:${mid}`,
            disagreeKey: `dec:disagree:${mid}`,
          };
        if (e.relationType === "agree") res[mid].agreeCount++;
        if (e.relationType === "disagree") res[mid].disagreeCount++;
      }
    }
    return res;
  }, [edges]);

  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);

  const doubleClickToggleRef = useRef<{
    messageId: string;
    time: number;
    wasExit: boolean;
  } | null>(null);

  const lastAddedFragmentRef = useRef<{
    messageId: string;
    unit: UnitSelection;
    time: number;
  } | null>(null);

  const mouseDownRef = useRef<{
    x: number;
    y: number;
    messageId: string | null;
  } | null>(null);
  const lastDragOrSelectTimeRef = useRef<number>(0);

  const lastClickActionsRef = useRef<
    {
      type: "toggleWhole";
      messageId: string;
      prevExisted: boolean;
      time: number;
    }[]
  >([]);

  function captureSnapshot(): FocusSnapshot {
    return {
      leftScroll: leftPanelRef.current
        ? {
            top: leftPanelRef.current.scrollTop,
            left: leftPanelRef.current.scrollLeft,
          }
        : null,
      rightScroll: rightPanelRef.current
        ? {
            top: rightPanelRef.current.scrollTop,
            left: rightPanelRef.current.scrollLeft,
          }
        : null,
      draftUnits: draftUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      })),
      sourceUnits: sourceUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      })),
      targetUnits: targetUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      })),
      activeTextSelectId,
      lastClickedMessageId,
    };
  }

  function clampAndSetScroll(
    container: HTMLDivElement | null,
    top: number | null,
    left: number | null
  ) {
    if (!container) return;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    if (top !== null) container.scrollTop = Math.min(Math.max(0, top), maxTop);
    if (left !== null)
      container.scrollLeft = Math.min(Math.max(0, left), maxLeft);
  }

  function restoreSnapshot(s: FocusSnapshot | null) {
    if (!s) return;
    setDraftUnits(
      s.draftUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      }))
    );
    setSourceUnits(
      s.sourceUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      }))
    );
    setTargetUnits(
      s.targetUnits.map((u) => ({
        ...u,
        selection: { ...(u.selection as any) },
      }))
    );
    setActiveTextSelectId(s.activeTextSelectId);
    setLastClickedMessageId(s.lastClickedMessageId);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clampAndSetScroll(
          leftPanelRef.current,
          s.leftScroll?.top ?? null,
          s.leftScroll?.left ?? null
        );
        clampAndSetScroll(
          rightPanelRef.current,
          s.rightScroll?.top ?? null,
          s.rightScroll?.left ?? null
        );
      });
    });
  }

  // enterFocus: push a single-message entry (ids array with single id)
  function enterFocus(messageId: string, options?: { replace?: boolean }) {
    if (!messageId) return;
    const snapshot = captureSnapshot();
    const entry = { ids: [messageId], snapshot } as {
      ids: string[];
      snapshot: FocusSnapshot | null;
    };
    setFocusEntries((prev) => {
      if (options?.replace) {
        return [entry];
      }
      return [...prev, entry];
    });
  }

  // enterFocusMultiple: push one entry containing multiple ids
  function enterFocusMultiple(
    messageIds: string[],
    options?: { replace?: boolean }
  ) {
    if (!messageIds || messageIds.length === 0) return;
    const snapshot = captureSnapshot();
    const entry = { ids: messageIds, snapshot } as {
      ids: string[];
      snapshot: FocusSnapshot | null;
    };
    setFocusEntries((prev) => {
      if (options?.replace) {
        return [entry];
      }
      return [...prev, entry];
    });
  }

  // NEW: exitFocus -> pop most recent entry and restore its snapshot
  function exitFocus() {
    setFocusEntries((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const rest = prev.slice(0, -1);
      restoreSnapshot(last.snapshot);
      return rest;
    });
  }

  // NEW: clear ALL focus entries in one click and restore snapshot prior to first focus
  function exitAllFocus() {
    setFocusEntries((prev) => {
      if (prev.length === 0) return prev;
      // restore snapshot captured before the first focus entry
      const first = prev[0];
      restoreSnapshot(first.snapshot);
      return [];
    });
  }

  function clearDraftAll() {
    setDraftUnits([]);
    setActiveTextSelectId(null);
    clearBrowserSelection();
  }

  function isFragmentSelected(
    messageId: string,
    start: number,
    len: number,
    text: string
  ) {
    const u: UnitSelection = {
      messageId,
      selection: { kind: "text", start, len, text },
    };
    return draftUnits.some((x) => unitEquals(x, u));
  }

  function toggleFragmentSelection(
    messageId: string,
    start: number,
    len: number,
    text: string
  ) {
    const u: UnitSelection = {
      messageId,
      selection: { kind: "text", start, len, text },
    };
    setDraftUnits((prev) => {
      const exists = prev.some((x) => unitEquals(x, u));
      return exists ? prev.filter((x) => !unitEquals(x, u)) : [...prev, u];
    });
  }

  function handleSendMessageOnly(): Message | null {
    const text = newMessageContent;
    if (text.trim().length === 0) return null;
    const msg: Message = {
      id: nextId("msg"),
      author: "You",
      createdAt: new Date().toISOString(),
      content: text,
      kind: "normal",
    };
    setMessages((prev) => [...prev, msg]);
    setNewMessageContent("");
    return msg;
  }

  function handleMessageMouseDown(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;
    mouseDownRef.current = { x: e.clientX, y: e.clientY, messageId };
  }

  function undoRecentClickActionsForMessage(messageId: string) {
    const now = Date.now();
    const windowMs = 600;
    const arr = lastClickActionsRef.current;
    if (!arr || arr.length === 0) return;
    const indices: number[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (now - a.time > windowMs) continue;
      if (a.messageId === messageId) indices.push(i);
    }
    if (indices.length === 0) return;

    setDraftUnits((prev) => {
      let cur = [...prev];
      for (const idx of indices) {
        const a = arr[idx];
        if (a.type === "toggleWhole") {
          const wholeUnit: UnitSelection = {
            messageId: a.messageId,
            selection: { kind: "whole" },
          };
          if (a.prevExisted) {
            if (!cur.some((u) => unitEquals(u, wholeUnit))) cur.push(wholeUnit);
          } else {
            cur = cur.filter((u) => !unitEquals(u, wholeUnit));
          }
        }
      }
      return cur;
    });

    lastClickActionsRef.current = arr.filter(
      (_v, idx) => !indices.includes(idx)
    );
  }

  function handleMessageMouseUp(e: React.MouseEvent, messageId: string) {
    if (!mouseDownRef.current) return;
    const md = mouseDownRef.current;
    mouseDownRef.current = null;
    if (md.messageId !== messageId) return;
    const dx = Math.abs(md.x - e.clientX);
    const dy = Math.abs(md.y - e.clientY);
    const moved = dx > 6 || dy > 6;
    if (moved) {
      lastDragOrSelectTimeRef.current = Date.now();
      undoRecentClickActionsForMessage(messageId);
    }
  }

  function handleMessageClick(e: React.MouseEvent, messageId: string) {
    if (e.button !== 0) return;

    if (Date.now() - lastDragOrSelectTimeRef.current < 350) return;

    e.stopPropagation();
    setLastClickedMessageId(messageId);
    const wholeUnit: UnitSelection = {
      messageId,
      selection: { kind: "whole" },
    };

    setDraftUnits((prev) => {
      const exists = prev.some((u) => unitEquals(u, wholeUnit));
      const next = exists
        ? prev.filter((u) => !unitEquals(u, wholeUnit))
        : [...prev, wholeUnit];

      lastClickActionsRef.current.push({
        type: "toggleWhole",
        messageId,
        prevExisted: exists,
        time: Date.now(),
      });
      const now = Date.now();
      lastClickActionsRef.current = lastClickActionsRef.current.filter(
        (a) => now - a.time < 2000
      );

      return next;
    });
  }

  function handleMessageDoubleClick(e: React.MouseEvent, messageId: string) {
    e.stopPropagation();

    undoRecentClickActionsForMessage(messageId);

    const m = msgMap.get(messageId);
    setLastClickedMessageId(messageId);

    const currentlyActive = activeTextSelectId === messageId;

    if (m?.kind === "relation") {
      if (currentlyActive) {
        setActiveTextSelectId(null);
        clearBrowserSelection();
      }
      return;
    }

    if (currentlyActive) {
      const laf = lastAddedFragmentRef.current;
      if (laf && laf.messageId === messageId && Date.now() - laf.time < 450) {
        setDraftUnits((prev) => prev.filter((u) => !unitEquals(u, laf.unit)));
        lastAddedFragmentRef.current = null;
      }
      setActiveTextSelectId(null);
      clearBrowserSelection();
      return;
    }

    setActiveTextSelectId(messageId);
    clearBrowserSelection();
  }

  function handleTextMouseUp(e: React.MouseEvent, messageId: string) {
    if (!activeTextSelectId) return;
    if (activeTextSelectId !== messageId) return;

    const m = msgMap.get(messageId);
    if (!m || m.kind !== "normal") return;

    const container = e.currentTarget as HTMLElement;
    const frag = getSelectionFragment(container);
    clearBrowserSelection();
    if (!frag) return;
    if (frag.len <= 0) return;

    const fragmentUnit: UnitSelection = {
      messageId,
      selection: {
        kind: "text",
        start: frag.start,
        len: frag.len,
        text: frag.text,
      },
    };

    setDraftUnits((prev) => {
      const exists = prev.some((u) => unitEquals(u, fragmentUnit));
      const next = exists
        ? prev.filter((u) => !unitEquals(u, fragmentUnit))
        : [...prev, fragmentUnit];

      return next;
    });

    lastAddedFragmentRef.current = {
      messageId,
      unit: fragmentUnit,
      time: Date.now(),
    };

    lastDragOrSelectTimeRef.current = Date.now();

    undoRecentClickActionsForMessage(messageId);
  }

  function handleFragmentAnchorClick(
    messageId: string,
    start: number,
    len: number,
    text: string
  ) {
    setActiveTextSelectId(messageId);
    clearBrowserSelection();
    toggleFragmentSelection(messageId, start, len, text);
    setLastClickedMessageId(messageId);

    undoRecentClickActionsForMessage(messageId);
  }

  function commitDraftTo(role: "source" | "target") {
    if (draftUnits.length === 0) return;
    if (role === "source")
      setSourceUnits((prev) => mergeUnits(prev, draftUnits));
    else setTargetUnits((prev) => mergeUnits(prev, draftUnits));
    setDraftUnits([]);
    setActiveTextSelectId(null);
  }

  function removeUnitFrom(role: "source" | "target", unit: UnitSelection) {
    const update = (list: UnitSelection[]) =>
      list.filter((u) => !unitEquals(u, unit));
    if (role === "source") setSourceUnits((prev) => update(prev));
    else setTargetUnits((prev) => update(prev));
  }

  function removeUnitFromDraft(unit: UnitSelection) {
    setDraftUnits((prev) => prev.filter((u) => !unitEquals(u, unit)));
  }

  // helper：返回 relation 下所有 edgeId
  function getEdgeIdsForRelation(relationMessageId: string) {
    return edges
      .filter((e) => e.relationMessageId === relationMessageId)
      .map((e) => e.id);
  }

  function relationAllFragmentsSelected(
    relationMessageId: string,
    units: UnitSelection[]
  ) {
    const edgeIds = getEdgeIdsForRelation(relationMessageId);
    if (edgeIds.length === 0)
      return units.some(
        (u) => u.messageId === relationMessageId && u.selection.kind === "whole"
      );
    const have = new Set(
      units
        .filter(
          (u) =>
            u.messageId === relationMessageId && u.selection.kind === "edge"
        )
        .map((u) => (u.selection as any).edgeId)
    );
    return edgeIds.every((id) => have.has(id));
  }

  function ensureRelationWholeSynced(relationMessageId: string) {
    setDraftUnits((prev) => {
      const shouldHaveWhole = relationAllFragmentsSelected(
        relationMessageId,
        prev
      );
      const wholeUnit: UnitSelection = {
        messageId: relationMessageId,
        selection: { kind: "whole" },
      };
      const hasWhole = prev.some((u) => unitEquals(u, wholeUnit));

      // build list without changing other messages
      let next = [...prev];

      if (shouldHaveWhole && !hasWhole) {
        next.push(wholeUnit);
      } else if (!shouldHaveWhole && hasWhole) {
        next = next.filter((u) => !unitEquals(u, wholeUnit));
      }
      return next;
    });
  }

  // 改写 handleEdgeLabelSingleClick（切换单个 fragment 后同步 whole）
  function handleEdgeLabelSingleClick(
    e: React.MouseEvent,
    relationMessageId: string,
    edgeId: string
  ) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);

    const unit: UnitSelection = {
      messageId: relationMessageId,
      selection: { kind: "edge", edgeId },
    };
    setDraftUnits((prev) => {
      const exists = prev.some((u) => unitEquals(u, unit));
      const next = exists
        ? prev.filter((u) => !unitEquals(u, unit))
        : [...prev, unit];
      // 同步 whole（在 setState 回调外也可以，但这里可在下一轮 effect 中再调用）
      // 我们返回 next，并随后在微任务中检查/同步（防止读取旧 state）
      setTimeout(() => ensureRelationWholeSynced(relationMessageId), 0);
      return next;
    });
  }

  // 改写 handleEdgeLabelDoubleClick（加入/移除整条同时加入/移除所有 fragments）
  function handleEdgeLabelDoubleClick(
    e: React.MouseEvent,
    relationMessageId: string
  ) {
    e.stopPropagation();
    setLastClickedMessageId(relationMessageId);

    const wholeUnit: UnitSelection = {
      messageId: relationMessageId,
      selection: { kind: "whole" },
    };
    const edgeIds = getEdgeIdsForRelation(relationMessageId);
    const edgeUnits = edgeIds.map((id) => ({
      messageId: relationMessageId,
      selection: { kind: "edge", edgeId: id } as Selection,
    }));

    setDraftUnits((prev) => {
      const hasWhole = prev.some((u) => unitEquals(u, wholeUnit));
      if (hasWhole) {
        // remove whole AND all fragment units for this relation
        return prev.filter(
          (u) =>
            !(
              u.messageId === relationMessageId &&
              (u.selection.kind === "whole" || u.selection.kind === "edge")
            )
        );
      } else {
        // add whole and add all fragments (avoid dup)
        const merged = mergeUnits(prev, edgeUnits as UnitSelection[]);
        // ensure whole present
        if (!merged.some((u) => unitEquals(u, wholeUnit)))
          merged.push(wholeUnit);
        return merged;
      }
    });
  }

  function handleCreateRelationWithSourcesAndTargets(params: {
    sources: UnitSelection[];
    targets: UnitSelection[];
    label: string;
    now: string;
  }) {
    const { sources, targets, label, now } = params;

    const relationMsgId = nextId("rel");
    const relationMsg: Message = {
      id: relationMsgId,
      author: "System",
      createdAt: now,
      kind: "relation",
      content: `建立${relationTypeName(relationType)}关系：${describeUnit(
        sources[0]
      )} ${relationTypeName(relationType)}了 ${describeUnit(
        targets[0]
      )}；标签：${label}`,
    };

    const newEdges: Edge[] = [];

    if (relationType === "reply") {
      const fromReply = foldUpToWhole(sources);
      const toReply = foldUpToWhole(targets);

      for (const s of fromReply) {
        for (const t of toReply) {
          newEdges.push({
            id: nextId("edge"),
            relationMessageId: relationMsg.id,
            relationType: "reply",
            from: { messageId: s.messageId, selection: { kind: "whole" } },
            to: { messageId: t.messageId, selection: { kind: "whole" } },
            relationLabel: label,
          });
        }
      }

      if (secondaryRelationType !== "none") {
        const secType: RelationType =
          secondaryRelationType === "annotation" ? "annotation" : "reference";
        for (const s of sources) {
          for (const t of targets) {
            newEdges.push({
              id: nextId("edge"),
              relationMessageId: relationMsg.id,
              relationType: secType,
              from: s,
              to: t,
              relationLabel: label,
            });
          }
        }
      }
    } else if (
      relationType === "agree" ||
      relationType === "disagree" ||
      relationType === "support" ||
      relationType === "rebut"
    ) {
      // For votes/support/rebut, target the decoration (dec:agree:mid or dec:disagree:mid)
      const decKind =
        relationType === "disagree" || relationType === "rebut"
          ? "disagree"
          : "agree";

      for (const s of sources) {
        for (const t of targets) {
          // Normalize target: always reference the message id (even if selection is text/whole)
          const targetMid = t.messageId;
          const toSel: Selection = {
            kind: "edge",
            edgeId: `dec:${decKind}:${targetMid}`,
          };
          newEdges.push({
            id: nextId("edge"),
            relationMessageId: relationMsg.id,
            relationType,
            from: s,
            to: { messageId: targetMid, selection: toSel },
            relationLabel: label,
          });
        }
      }
    } else {
      // annotation / reference or any other simple relation -> keep original behavior
      for (const s of sources) {
        for (const t of targets) {
          newEdges.push({
            id: nextId("edge"),
            relationMessageId: relationMsg.id,
            relationType,
            from: s,
            to: t,
            relationLabel: label,
          });
        }
      }
    }

    setMessages((prev) => [...prev, relationMsg]);
    setEdges((prev) => [...prev, ...newEdges]);
  }

  function handleCreateRelation(useNewMessageAsSource: boolean) {
    if (targetUnits.length === 0) return;
    if (!useNewMessageAsSource && sourceUnits.length === 0) return;
    if (useNewMessageAsSource && newMessageContent.trim().length === 0) return;

    const now = new Date().toISOString();
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;

    let sources: UnitSelection[] = [];
    if (useNewMessageAsSource) {
      const msg = handleSendMessageOnly();
      if (!msg) return;
      sources = [{ messageId: msg.id, selection: { kind: "whole" } }];
    } else {
      sources = [...sourceUnits];
    }

    const targets = [...targetUnits];
    handleCreateRelationWithSourcesAndTargets({ sources, targets, label, now });

    setDraftUnits([]);
    setSourceUnits([]);
    setTargetUnits([]);
    setActiveTextSelectId(null);
    clearBrowserSelection();
  }

  function handleQuickSendAndRelateFromDraftTargets() {
    if (newMessageContent.trim().length === 0) return;
    if (draftUnits.length === 0) return;

    const now = new Date().toISOString();
    const labelDefault = relationTypeName(relationType);
    const label = relationLabel.trim() || labelDefault;

    const msg = handleSendMessageOnly();
    if (!msg) return;

    const sources: UnitSelection[] = [
      { messageId: msg.id, selection: { kind: "whole" } },
    ];
    const targets: UnitSelection[] = [...draftUnits];

    handleCreateRelationWithSourcesAndTargets({ sources, targets, label, now });

    setDraftUnits([]);
    setSourceUnits([]);
    setTargetUnits([]);
    setActiveTextSelectId(null);
    clearBrowserSelection();
  }

  type DraftGroup = {
    messageId: string;
    wholeSelected: boolean;
    fragments: UnitSelection[];
  };

  const draftGroups: DraftGroup[] = useMemo(() => {
    const map = new Map<string, DraftGroup>();
    for (const u of draftUnits) {
      const g =
        map.get(u.messageId) ||
        ({
          messageId: u.messageId,
          wholeSelected: false,
          fragments: [] as UnitSelection[],
        } as DraftGroup);
      if (u.selection.kind === "whole") g.wholeSelected = true;
      else g.fragments.push(u);
      map.set(u.messageId, g);
    }
    return Array.from(map.values());
  }, [draftUnits]);

  const prevDraftCountRef = useRef<number>(draftUnits.length);
  useEffect(() => {
    const prev = prevDraftCountRef.current;
    const cur = draftUnits.length;
    if (prev > 0 && cur === 0 && activeTextSelectId !== null) {
      setActiveTextSelectId(null);
    }
    prevDraftCountRef.current = cur;
  }, [draftUnits, activeTextSelectId]);

  function getSelectedWholeMessageIds(): string[] {
    const ids = draftUnits
      .filter((u) => u.selection.kind === "whole")
      .map((u) => u.messageId);
    return Array.from(new Set(ids));
  }

  const recentRelations = useMemo(() => {
    return messages
      .filter((m) => m.kind === "relation")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, 5);
  }, [messages]);

  const recentNormals = useMemo(() => {
    return messages
      .filter((m) => m.kind === "normal")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, 8);
  }, [messages]);

  const exported = useMemo(
    () => exportScriptV2(messages, edges),
    [messages, edges]
  );
  const quickButtonEnabled =
    newMessageContent.trim().length > 0 && draftUnits.length > 0;

  function renderMessageContentWithAnchorsForList(message: Message) {
    const targets = extractTextTargetsForMessage(message.id, edges);
    if (targets.length === 0) {
      return (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
            fontSize: 13,
          }}
        >
          {message.content}
        </pre>
      );
    }

    const text = message.content;
    const segs: { start: number; end: number; relationType: RelationType }[] =
      [];
    let lastEnd = -1;
    for (const t of targets) {
      const start = t.start;
      const end = t.start + t.len;
      if (start < 0 || end > text.length || t.len <= 0) continue;
      if (start < lastEnd) continue;
      segs.push({ start, end, relationType: t.relationType });
      lastEnd = end;
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    for (const s of segs) {
      if (cursor < s.start)
        nodes.push(
          <span key={`t-${cursor}`}>{text.slice(cursor, s.start)}</span>
        );

      const frag = text.slice(s.start, s.end);
      const isAnno = s.relationType === "annotation";
      const len = s.end - s.start;
      const selected = isFragmentSelected(message.id, s.start, len, frag);

      nodes.push(
        <span
          key={`h-${s.start}-${s.end}`}
          onClick={(e) => {
            e.stopPropagation();
            handleFragmentAnchorClick(message.id, s.start, len, frag);
          }}
          style={{
            cursor: "pointer",
            backgroundColor: selected
              ? "rgba(11,132,255,0.18)"
              : isAnno
              ? "rgba(255,255,0,0.12)"
              : "rgba(80,180,255,0.08)",
            outline: selected
              ? "2px solid rgba(11,132,255,0.95)"
              : isAnno
              ? "1px solid rgba(255,255,0,0.8)"
              : "1px solid rgba(80,180,255,0.45)",
            borderRadius: 2,
            whiteSpace: "pre-wrap",
          }}
          title="点击：进入文本选择状态并切换选中该片段"
        >
          {frag}
        </span>
      );

      cursor = s.end;
    }

    if (cursor < text.length)
      nodes.push(<span key={`t-${cursor}`}>{text.slice(cursor)}</span>);

    return (
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
          fontSize: 13,
        }}
      >
        {nodes}
      </pre>
    );
  }

  // Multi-focus BFS (增强：当焦点包含 relation 且 focusHop === 0 时，将 relation 展开为其连接的 normal 消息作为起点)
  const { messagesToShow, edgesToShow } = useMemo(() => {
    if (focusEntries.length === 0)
      return { messagesToShow: messages, edgesToShow: edges };

    // Use the most recent focus entry's ids as BFS start points (only the top of the focus stack)
    const startIds =
      focusEntries.length > 0
        ? focusEntries[focusEntries.length - 1].ids.filter(Boolean)
        : [];

    if (startIds.length === 0)
      return { messagesToShow: messages, edgesToShow: edges };

    // Build adjacency (same as before)
    const adj = new Map<string, Set<string>>();
    function addEdgeAdj(a: string, b: string) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }

    for (const e of edges) {
      const a = e.from.messageId;
      const b = e.to.messageId;
      const r = e.relationMessageId;
      addEdgeAdj(a, b);
      addEdgeAdj(r, a);
      addEdgeAdj(r, b);
    }

    // --- NEW: compute effective start ids
    // If focusHop === 0 and any of the startIds is a relation message, expand it to include connected normal messages.
    // This makes selecting a relation (or a relation fragment, represented by the relation message id) behave like
    // selecting the textual messages it connects when hop = 0.
    const effectiveStartIds = new Set<string>(startIds);

    if (focusHop === 0) {
      for (const id of startIds) {
        const m = msgMap.get(id);
        if (m && m.kind === "relation") {
          // find edges that belong to this relation message and add their connected normal messages
          for (const e of edges) {
            if (e.relationMessageId !== id) continue;
            const f = e.from.messageId;
            const t = e.to.messageId;
            const mf = msgMap.get(f);
            const mt = msgMap.get(t);
            if (mf && mf.kind === "normal") effectiveStartIds.add(f);
            if (mt && mt.kind === "normal") effectiveStartIds.add(t);
          }
        }
      }
    }
    // --- END NEW

    // BFS from effectiveStartIds
    const dist = new Map<string, number>();
    const q: string[] = [];
    for (const id of Array.from(effectiveStartIds)) {
      if (!dist.has(id)) {
        dist.set(id, 0);
        q.push(id);
      }
    }

    while (q.length > 0) {
      const cur = q.shift()!;
      const d = dist.get(cur)!;
      if (d >= focusHop) continue;
      const neighbors = adj.get(cur);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          q.push(nb);
        }
      }
    }

    const messagesToShow = messages.filter((m) => dist.has(m.id));

    // Keep relation messages that relate to shown normal messages (same logic as before)
    const shownIds = new Set(messagesToShow.map((m) => m.id));
    const relationMessagesToAdd = new Set<string>();
    for (const e of edges) {
      if (shownIds.has(e.from.messageId) || shownIds.has(e.to.messageId)) {
        relationMessagesToAdd.add(e.relationMessageId);
      }
    }
    for (const rmId of relationMessagesToAdd) {
      if (!shownIds.has(rmId)) {
        const m = messages.find((x) => x.id === rmId);
        if (m) messagesToShow.push(m);
      }
    }

    const shownSet = new Set(messagesToShow.map((m) => m.id));
    const edgesToShow = edges.filter(
      (e) =>
        shownSet.has(e.from.messageId) ||
        shownSet.has(e.to.messageId) ||
        shownSet.has(e.relationMessageId)
    );

    return { messagesToShow, edgesToShow };
  }, [messages, edges, focusEntries, focusHop]);

  const canSetFocus =
    (!!lastClickedMessageId &&
      messages.some((m) => m.id === lastClickedMessageId)) ||
    getSelectedWholeMessageIds().length > 0;
  const canExitFocus = focusEntries.length > 0;

  function handleCanvasBlankClick() {
    setDraftUnits([]);
    setSourceUnits([]);
    setTargetUnits([]);
    setActiveTextSelectId(null);
    clearBrowserSelection();
    setLastClickedMessageId(null);
  }

  // Clicking a decoration (agree/disagree box) — convenience handler:
  function handleDecorationClick(
    messageId: string,
    kind: "agree" | "disagree"
  ) {
    // Make a quick vote relation: create a small "You" message and a relation edge pointing to dec:... target.
    const now = new Date().toISOString();
    const msg: Message = {
      id: nextId("msg"),
      author: "You",
      createdAt: now,
      content: kind === "agree" ? "赞同" : "反对",
      kind: "normal",
    };
    const relMsgId = nextId("rel");
    const relMsg: Message = {
      id: relMsgId,
      author: "System",
      createdAt: now,
      kind: "relation",
      content: `${msg.id} ${relationTypeName(
        kind === "agree" ? "agree" : "disagree"
      )} ${messageId}`,
    };
    const edge: Edge = {
      id: nextId("edge"),
      relationMessageId: relMsg.id,
      relationType: kind === "agree" ? "agree" : "disagree",
      from: { messageId: msg.id, selection: { kind: "whole" } },
      to: {
        messageId,
        selection: { kind: "edge", edgeId: `dec:${kind}:${messageId}` },
      },
      relationLabel: relationTypeName(kind === "agree" ? "agree" : "disagree"),
    };
    setMessages((prev) => [...prev, msg, relMsg]);
    setEdges((prev) => [...prev, edge]);
  }

  if (loading) {
    return (
      <div
        style={{
          padding: 16,
          background: "#101010",
          color: "#eee",
          height: "100vh",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Loading initial_script.txt…
        </div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>
          正在从 /initial_script.txt 读取内置消息脚本（v2：MSG len=… + END）。
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        style={{
          padding: 16,
          background: "#101010",
          color: "#eee",
          height: "100vh",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Failed to load initial_script.txt
        </div>
        <pre style={{ whiteSpace: "pre-wrap", color: "#ff8080" }}>
          {loadError}
        </pre>
        <div style={{ opacity: 0.8, fontSize: 12, marginTop: 8 }}>
          请确认 public/initial_script.txt 存在且格式为：MSG ... len=... /
          END；REL ... / END。
        </div>
      </div>
    );
  }

  const messagesToRender = focusEntries.length > 0 ? messagesToShow : messages;
  const edgesToRender = focusEntries.length > 0 ? edgesToShow : edges;

  return (
    <div
      style={{
        height: "100vh",
        margin: 0,
        display: "flex",
        flexDirection: "column",
        background: "#101010",
        color: "#eee",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #333",
          background: "#181818",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 14,
        }}
      >
        <div>
          <span style={{ fontWeight: 600, marginRight: 12 }}>
            Demo（v2解析修复：len 对齐 END；注释/引用列规则1）
          </span>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            注释/引用：start+len（UTF-16）。
          </span>
        </div>

        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <span>关系类型：</span>
          <button
            onClick={() => {
              setRelationType("annotation");
              setSecondaryRelationType("none");
            }}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "annotation" ? "#0b84ff" : "#222",
              color:
                relationType === "annotation"
                  ? "#fff"
                  : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            注释
          </button>
          <button
            onClick={() => {
              setRelationType("reference");
              setSecondaryRelationType("none");
            }}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "reference" ? "#0b84ff" : "#222",
              color:
                relationType === "reference" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            引用
          </button>
          <button
            onClick={() => setRelationType("reply")}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "reply" ? "#0b84ff" : "#222",
              color:
                relationType === "reply" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            回复
          </button>

          {/* New relation types: agree/disagree/support/rebut */}
          <button
            onClick={() => setRelationType("agree")}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "agree" ? "#0b84ff" : "#222",
              color:
                relationType === "agree" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            赞同
          </button>
          <button
            onClick={() => setRelationType("disagree")}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "disagree" ? "#0b84ff" : "#222",
              color:
                relationType === "disagree" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            反对
          </button>
          <button
            onClick={() => setRelationType("support")}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "support" ? "#0b84ff" : "#222",
              color:
                relationType === "support" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            支持
          </button>
          <button
            onClick={() => setRelationType("rebut")}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #666",
              background: relationType === "rebut" ? "#0b84ff" : "#222",
              color:
                relationType === "rebut" ? "#fff" : "rgba(255,255,255,0.7)",
              cursor: "pointer",
            }}
          >
            反驳
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div
          style={{
            flex: 2,
            borderRight: "1px solid #333",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: "0 0 auto",
              padding: 8,
              borderBottom: "1px solid #333",
              background: "#141414",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {viewMode === "list" ? "消息列表（线性）" : "结构图（非线性）"}
              </div>
              <button
                onClick={() =>
                  setViewMode((prev) => (prev === "list" ? "graph" : "list"))
                }
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background: "#333",
                  color: "#fff",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {viewMode === "list" ? "切换为结构图" : "切换为列表"}
              </button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {viewMode === "list"
                ? "线性视图：支持自由换行内容；双击 normal 进入文本选择模式；可点击高亮片段切换选中。"
                : "结构图：注释/引用 source 自动推到 target 右侧列（规则1）；label避让文字；高亮片段可点击。"}
            </div>
          </div>

          <div
            ref={leftPanelRef}
            style={{ flex: "1 1 auto", overflow: "auto", padding: 8 }}
          >
            {viewMode === "list" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {messagesToRender.map((msg) => {
                  const isWholeSelected = draftUnits.some(
                    (u) =>
                      u.messageId === msg.id && u.selection.kind === "whole"
                  );
                  const isActiveText = activeTextSelectId === msg.id;

                  return (
                    <div
                      key={msg.id}
                      onClick={(e) => handleMessageClick(e, msg.id)}
                      onDoubleClick={(e) => handleMessageDoubleClick(e, msg.id)}
                      onMouseDown={(e) => handleMessageMouseDown(e, msg.id)}
                      onMouseUp={(e) => handleMessageMouseUp(e, msg.id)}
                      style={{
                        borderRadius: 6,
                        border:
                          msg.kind === "relation"
                            ? "1px solid #886400"
                            : isActiveText
                            ? "2px dashed #0b84ff"
                            : isWholeSelected
                            ? "2px solid #0b84ff"
                            : "1px solid #444",
                        background:
                          msg.kind === "relation" ? "#232018" : "#1f1f1f",
                        padding: 8,
                        cursor: "pointer",
                        fontSize: 13,
                        outline:
                          lastClickedMessageId === msg.id
                            ? "1px dashed #0b84ff"
                            : "none",
                        userSelect: isActiveText ? "text" : "auto",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          opacity: 0.8,
                          marginBottom: 4,
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>
                          {msg.kind === "relation"
                            ? `关系消息 ${msg.id}`
                            : `消息 ${msg.id}`}
                        </span>
                        <span>作者：{msg.author}</span>
                      </div>

                      {isActiveText && msg.kind === "normal" && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#0b84ff",
                            marginBottom: 4,
                          }}
                        >
                          文本选择模式：拖选记录 start+len；或点击高亮片段
                        </div>
                      )}

                      <div
                        style={{ fontSize: 13, color: "#f5f5f5" }}
                        onMouseUp={(e) =>
                          msg.kind === "normal" && handleTextMouseUp(e, msg.id)
                        }
                      >
                        {msg.kind === "normal" ? (
                          renderMessageContentWithAnchorsForList(msg)
                        ) : (
                          <div
                            style={{
                              whiteSpace: "pre-wrap",
                              fontFamily:
                                "Menlo, Monaco, Consolas, 'Courier New', monospace",
                              fontSize: 12,
                            }}
                          >
                            {msg.content}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ minHeight: 900 }}>
                <GraphView
                  messages={messagesToRender}
                  edges={edgesToRender}
                  draftUnits={draftUnits}
                  activeTextSelectId={activeTextSelectId}
                  lastClickedMessageId={lastClickedMessageId}
                  onMessageClick={handleMessageClick}
                  onMessageDoubleClick={handleMessageDoubleClick}
                  onTextMouseUp={handleTextMouseUp}
                  onEdgeLabelSingleClick={handleEdgeLabelSingleClick}
                  onEdgeLabelDoubleClick={handleEdgeLabelDoubleClick}
                  onFragmentAnchorClick={handleFragmentAnchorClick}
                  isFragmentSelected={isFragmentSelected}
                  onCanvasBlankClick={handleCanvasBlankClick}
                  onMessageMouseDown={handleMessageMouseDown}
                  onMessageMouseUp={handleMessageMouseUp}
                  voteStats={voteStats}
                  onDecorationClick={handleDecorationClick}
                />
              </div>
            )}
          </div>
        </div>

        <div
          ref={rightPanelRef}
          style={{
            flex: 2,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflow: "auto",
            minWidth: 0,
          }}
        >
          <div
            style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
                alignItems: "center",
              }}
            >
              <div style={{ fontWeight: 600 }}>候选区（Draft）</div>
              <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                <button
                  onClick={clearDraftAll}
                  disabled={draftUnits.length === 0 && !activeTextSelectId}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: "1px solid #666",
                    background:
                      draftUnits.length === 0 && !activeTextSelectId
                        ? "#333"
                        : "#444",
                    color:
                      draftUnits.length === 0 && !activeTextSelectId
                        ? "#777"
                        : "#fff",
                    cursor:
                      draftUnits.length === 0 && !activeTextSelectId
                        ? "default"
                        : "pointer",
                  }}
                >
                  清空
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    onClick={() => {
                      const selWhole = getSelectedWholeMessageIds();
                      if (selWhole.length > 0) {
                        // 新语义：把选中的那些作为一个 entry 入栈（push）
                        enterFocusMultiple(selWhole, { replace: false });
                      } else if (lastClickedMessageId) {
                        enterFocus(lastClickedMessageId, { replace: false });
                      }
                    }}
                    disabled={!canSetFocus}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      border: "1px solid #666",
                      background: canSetFocus ? "#444" : "#333",
                      color: canSetFocus ? "#fff" : "#777",
                      cursor: canSetFocus ? "pointer" : "default",
                    }}
                  >
                    设为焦点消息
                  </button>

                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={exitFocus}
                      disabled={!canExitFocus}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 4,
                        border: "1px solid #666",
                        background: canExitFocus ? "#444" : "#333",
                        color: canExitFocus ? "#fff" : "#777",
                        cursor: canExitFocus ? "pointer" : "default",
                      }}
                      title="退出最近一次进入的焦点并恢复进入该焦点前的现场"
                    >
                      退出焦点
                    </button>

                    <button
                      onClick={exitAllFocus}
                      disabled={!canExitFocus}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 4,
                        border: "1px solid #666",
                        background: canExitFocus ? "#333" : "#222",
                        color: canExitFocus ? "#fff" : "#777",
                        cursor: canExitFocus ? "pointer" : "default",
                      }}
                      title="退出所有焦点并恢复进入第一个焦点前的现场"
                    >
                      退出全部
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                焦点距离（hop）：{focusHop}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => setFocusHop((h) => Math.max(0, h - 1))}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: "1px solid #666",
                    background: "#222",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  -
                </button>
                <button
                  onClick={() => setFocusHop((h) => Math.min(8, h + 1))}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: "1px solid #666",
                    background: "#222",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  +
                </button>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  （可设置 hop，默认 1，最大 8）
                </div>
              </div>
            </div>

            {draftGroups.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
                当前未选择任何候选。
              </div>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  paddingLeft: 0,
                  margin: 0,
                  maxHeight: 220,
                  overflow: "auto",
                  fontSize: 12,
                  marginTop: 8,
                }}
              >
                {draftGroups.map((g) => (
                  <li
                    key={`DG-${g.messageId}`}
                    style={{
                      borderBottom: "1px solid #333",
                      paddingBottom: 6,
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <span>
                        {g.messageId} · 整条：{g.wholeSelected ? "是" : "否"} ·
                        片段数：{g.fragments.length}
                      </span>
                      {g.wholeSelected && (
                        <button
                          onClick={() =>
                            removeUnitFromDraft({
                              messageId: g.messageId,
                              selection: { kind: "whole" },
                            })
                          }
                          style={{
                            fontSize: 10,
                            padding: "0 6px",
                            borderRadius: 4,
                            border: "1px solid #666",
                            background: "#333",
                            color: "#eee",
                            cursor: "pointer",
                          }}
                        >
                          删除整条
                        </button>
                      )}
                    </div>

                    {g.fragments.length > 0 && (
                      <ul
                        style={{
                          listStyle: "disc",
                          marginLeft: 18,
                          marginTop: 2,
                          marginBottom: 0,
                        }}
                      >
                        {g.fragments.map((u) => {
                          const s = u.selection;
                          const label =
                            s.kind === "edge"
                              ? `@edge:${s.edgeId}`
                              : s.kind === "text"
                              ? `start=${s.start} len=${s.len} "${s.text}"`
                              : "(whole)";
                          return (
                            <li
                              key={selKey(u)}
                              style={{
                                display: "flex",
                                gap: 8,
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <span
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {label}
                              </span>
                              <button
                                onClick={() => removeUnitFromDraft(u)}
                                style={{
                                  fontSize: 10,
                                  padding: "0 6px",
                                  borderRadius: 4,
                                  border: "1px solid #666",
                                  background: "#333",
                                  color: "#eee",
                                  cursor: "pointer",
                                  flex: "0 0 auto",
                                }}
                              >
                                删除片段
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                onClick={() => commitDraftTo("source")}
                disabled={draftUnits.length === 0}
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background: draftUnits.length === 0 ? "#333" : "#444",
                  color: draftUnits.length === 0 ? "#777" : "#fff",
                  cursor: draftUnits.length === 0 ? "default" : "pointer",
                  fontSize: 12,
                }}
              >
                加入来源集合
              </button>
              <button
                onClick={() => commitDraftTo("target")}
                disabled={draftUnits.length === 0}
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background: draftUnits.length === 0 ? "#333" : "#444",
                  color: draftUnits.length === 0 ? "#777" : "#fff",
                  cursor: draftUnits.length === 0 ? "default" : "pointer",
                  fontSize: 12,
                }}
              >
                加入目标集合
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div
              style={{
                flex: 1,
                border: "1px solid #444",
                borderRadius: 6,
                padding: 8,
                minWidth: 0,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Sources</div>
              {sourceUnits.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    paddingLeft: 0,
                    margin: 0,
                    maxHeight: 120,
                    overflow: "auto",
                    fontSize: 12,
                  }}
                >
                  {sourceUnits.map((u) => (
                    <li
                      key={selKey(u)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 6,
                      }}
                    >
                      <span>{describeUnit(u)}</span>
                      <button
                        onClick={() => removeUnitFrom("source", u)}
                        style={{
                          fontSize: 10,
                          padding: "0 6px",
                          borderRadius: 4,
                          border: "1px solid #666",
                          background: "#333",
                          color: "#eee",
                          cursor: "pointer",
                        }}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div
              style={{
                flex: 1,
                border: "1px solid #444",
                borderRadius: 6,
                padding: 8,
                minWidth: 0,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Targets</div>
              {targetUnits.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.6 }}>暂无。</div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    paddingLeft: 0,
                    margin: 0,
                    maxHeight: 120,
                    overflow: "auto",
                    fontSize: 12,
                  }}
                >
                  {targetUnits.map((u) => (
                    <li
                      key={selKey(u)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 6,
                      }}
                    >
                      <span>{describeUnit(u)}</span>
                      <button
                        onClick={() => removeUnitFrom("target", u)}
                        style={{
                          fontSize: 10,
                          padding: "0 6px",
                          borderRadius: 4,
                          border: "1px solid #666",
                          background: "#333",
                          color: "#eee",
                          cursor: "pointer",
                        }}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #444",
              borderRadius: 6,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ fontWeight: 600 }}>关系标签与消息文本</div>

            {relationType === "reply" && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 12,
                }}
              >
                <span style={{ opacity: 0.85 }}>附加关系：</span>
                {(
                  ["none", "annotation", "reference"] as SecondaryRelationType[]
                ).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSecondaryRelationType(t)}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      border: "1px solid #666",
                      background:
                        secondaryRelationType === t ? "#0b84ff" : "#222",
                      color:
                        secondaryRelationType === t
                          ? "#fff"
                          : "rgba(255,255,255,0.7)",
                      cursor: "pointer",
                    }}
                  >
                    {t === "none" ? "无" : t === "annotation" ? "注释" : "引用"}
                  </button>
                ))}
              </div>
            )}

            <input
              style={{
                width: "100%",
                padding: 4,
                borderRadius: 4,
                border: "1px solid #555",
                background: "#222",
                color: "#eee",
                fontSize: 12,
              }}
              placeholder={
                relationType === "annotation"
                  ? "注释标签"
                  : relationType === "reference"
                  ? "引用标签"
                  : relationType === "reply"
                  ? "回复标签"
                  : "回复/注释/引用/赞同/反对 标签"
              }
              value={relationLabel}
              onChange={(e) => setRelationLabel(e.target.value)}
            />

            <textarea
              style={{
                width: "100%",
                minHeight: 90,
                maxHeight: 220,
                padding: 4,
                borderRadius: 4,
                border: "1px solid #555",
                background: "#222",
                color: "#eee",
                fontSize: 13,
                resize: "vertical",
              }}
              placeholder="输入一条新普通消息（支持自由换行）"
              value={newMessageContent}
              onChange={(e) => setNewMessageContent(e.target.value)}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={handleSendMessageOnly}
                disabled={newMessageContent.trim().length === 0}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background:
                    newMessageContent.trim().length === 0 ? "#333" : "#444",
                  color:
                    newMessageContent.trim().length === 0 ? "#777" : "#fff",
                  cursor:
                    newMessageContent.trim().length === 0
                      ? "default"
                      : "pointer",
                  fontSize: 12,
                }}
              >
                仅发送消息
              </button>

              <button
                onClick={handleQuickSendAndRelateFromDraftTargets}
                disabled={!quickButtonEnabled}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background: !quickButtonEnabled ? "#333" : "#0b84ff",
                  color: !quickButtonEnabled ? "#777" : "#fff",
                  cursor: !quickButtonEnabled ? "default" : "pointer",
                  fontSize: 12,
                }}
                title="文本框作为来源（整条），候选区作为目标"
              >
                发送消息并建立关系（用候选作目标）
              </button>

              <button
                onClick={() => handleCreateRelation(true)}
                disabled={
                  newMessageContent.trim().length === 0 ||
                  targetUnits.length === 0
                }
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background:
                    newMessageContent.trim().length === 0 ||
                    targetUnits.length === 0
                      ? "#333"
                      : "#444",
                  color:
                    newMessageContent.trim().length === 0 ||
                    targetUnits.length === 0
                      ? "#777"
                      : "#fff",
                  cursor:
                    newMessageContent.trim().length === 0 ||
                    targetUnits.length === 0
                      ? "default"
                      : "pointer",
                  fontSize: 12,
                }}
              >
                发送新消息并建立关系（Targets集合）
              </button>

              <button
                onClick={() => handleCreateRelation(false)}
                disabled={sourceUnits.length === 0 || targetUnits.length === 0}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background:
                    sourceUnits.length === 0 || targetUnits.length === 0
                      ? "#333"
                      : "#444",
                  color:
                    sourceUnits.length === 0 || targetUnits.length === 0
                      ? "#777"
                      : "#fff",
                  cursor:
                    sourceUnits.length === 0 || targetUnits.length === 0
                      ? "default"
                      : "pointer",
                  fontSize: 12,
                }}
              >
                仅用已有消息建立关系（Sources/Targets集合）
              </button>
            </div>
          </div>

          <StructureView
            focusIds={currentFocusIds ?? []}
            messages={messages}
            edges={edges}
          />

          <div
            style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <div style={{ fontWeight: 600 }}>导出脚本（v2）</div>
              <button
                onClick={() => navigator.clipboard?.writeText(exported)}
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid #666",
                  background: "#333",
                  color: "#fff",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                复制
              </button>
            </div>
            <textarea
              readOnly
              value={exported}
              style={{
                width: "100%",
                minHeight: 180,
                maxHeight: 300,
                padding: 6,
                borderRadius: 6,
                border: "1px solid #555",
                background: "#151515",
                color: "#ddd",
                fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                fontSize: 11,
                resize: "vertical",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div
              style={{
                flex: 1,
                border: "1px solid #444",
                borderRadius: 6,
                padding: 8,
                minWidth: 0,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                最近普通消息
              </div>
              <ul
                style={{
                  listStyle: "none",
                  paddingLeft: 0,
                  margin: 0,
                  fontSize: 12,
                  maxHeight: 100,
                  overflow: "auto",
                }}
              >
                {recentNormals.map((m) => (
                  <li key={m.id}>
                    {m.id}：{m.content.slice(0, 40)}
                    {m.content.length > 40 ? "…" : ""}
                  </li>
                ))}
              </ul>
            </div>

            <div
              style={{
                flex: 1,
                border: "1px solid #444",
                borderRadius: 6,
                padding: 8,
                minWidth: 0,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                最近关系消息
              </div>
              <ul
                style={{
                  listStyle: "none",
                  paddingLeft: 0,
                  margin: 0,
                  fontSize: 12,
                  maxHeight: 100,
                  overflow: "auto",
                }}
              >
                {recentRelations.map((m) => (
                  <li key={m.id}>
                    {m.id}：{m.content.slice(0, 60)}
                    {m.content.length > 60 ? "…" : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div
            style={{ border: "1px solid #444", borderRadius: 6, padding: 8 }}
          >
            <div style={{ fontWeight: 600 }}>焦点</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              当前焦点：
              {currentFocusIds ? currentFocusIds.join(", ") : "（无）"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
