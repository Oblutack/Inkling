import { parseBlocks, type Inline } from "./markdownText";
import type { ProofSentence } from "../types";

// A mind map of a summary, made from the summary's own Markdown: the title in the middle, headings as branches, bullets and
// sentences as leaves. Nothing is asked of the model: it is free and instant.

export interface MapNode {
  id: number;
  text: string;
  // "root" is the title, "branch" a heading, "leaf" a point under it. A point that has points under it is a branch too.
  kind: "root" | "branch" | "leaf";
  children: MapNode[];
}

export interface MapTree {
  root: MapNode;
  nodes: number;
  // Points left out because the map is limited in size.
  omitted: number;
}

export const MAX_NODES = 150;
export const MAX_SENTENCES_PER_PARAGRAPH = 6;
const CITATION_MARKS = /\s*(?:\[\d+\]|【\d+】)/g;

const plain = (runs: Inline[]) => runs.map((r) => r.text).join("").replace(CITATION_MARKS, "").replace(/\s+/g, " ").trim();

const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])/u;

function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
}

// What a title and a heading are compared by: letters and digits only.
export function simplify(text: string): string {
  return text
    .toLowerCase()
    .replace(CITATION_MARKS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Reads the summary's Markdown into a tree under the document's title.
export function buildTree(title: string, markdown: string): MapTree {
  let nextId = 1;
  let count = 1;
  let omitted = 0;
  const root: MapNode = { id: nextId++, text: title.trim() || "Summary", kind: "root", children: [] };

  const add = (parent: MapNode, text: string, kind: "branch" | "leaf"): MapNode | null => {
    if (!text) return null;
    if (count >= MAX_NODES) {
      omitted += 1;
      return null;
    }
    count += 1;
    const node: MapNode = { id: nextId++, text, kind, children: [] };
    parent.children.push(node);
    if (parent.kind === "leaf") parent.kind = "branch";
    return node;
  };

  // The headings above the point being read, by level, and the points of the section that are open, by depth.
  const headings: Array<{ level: number; node: MapNode | null }> = [{ level: 0, node: root }];
  let points: Array<MapNode | null> = [];
  const section = () => headings[headings.length - 1].node ?? root;
  let firstHeadingSeen = false;

  for (const block of parseBlocks(markdown)) {
    const text = plain(block.runs);
    if (!text) continue;
    if (block.kind === "heading") {
      // a first heading that only repeats the title adds nothing
      if (!firstHeadingSeen && simplify(text) === simplify(root.text)) {
        firstHeadingSeen = true;
        continue;
      }
      firstHeadingSeen = true;
      while (headings.length > 1 && headings[headings.length - 1].level >= block.level) headings.pop();
      const parent = headings[headings.length - 1].node ?? root;
      headings.push({ level: block.level, node: add(parent, text, "branch") });
      points = [];
    } else if (block.kind === "bullet" || block.kind === "numbered") {
      firstHeadingSeen = true;
      const depth = block.kind === "bullet" ? block.depth : 0;
      const parent = depth > 0 ? (points[depth - 1] ?? points[points.length - 1] ?? section()) : section();
      const node = add(parent, text, "leaf");
      points = points.slice(0, depth);
      points[depth] = node;
    } else {
      firstHeadingSeen = true;
      const sentences = sentencesOf(text);
      for (const [i, sentence] of sentences.entries()) {
        if (i >= MAX_SENTENCES_PER_PARAGRAPH) {
          omitted += sentences.length - i;
          break;
        }
        add(section(), sentence, "leaf");
      }
      points = [];
    }
  }
  return { root, nodes: count, omitted };
}

// ---- layout -----------------------------------------------------------------------------------------------------------

export const NODE_WIDTH = 220;
export const COLUMN_GAP = 64;
export const ROW_GAP = 14;
export const LINE_HEIGHT = 17;
export const PADDING_Y = 10;
export const MARGIN = 24;
const LINE_CHARS = 28;
const MAX_LINES = 3;

// A text broken into lines that fit a node: at most three, the last ending in "…" if there is more.
export function wrapText(text: string, width = LINE_CHARS, maxLines = MAX_LINES): string[] {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > width ? word.slice(0, width - 1) + "…" : word));
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else if (lines.length === maxLines - 1) break;
    else {
      lines.push(line);
      line = word;
    }
    used += 1;
  }
  if (line) lines.push(line);
  if (used < words.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = (last.length >= width ? last.slice(0, width - 1) : last).replace(/[\s.,;:]+$/, "") + "…";
  }
  return lines.length ? lines : [""];
}

export interface PlacedNode {
  node: MapNode;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  parent: number | null;
}

export interface MapLayout {
  nodes: PlacedNode[];
  width: number;
  height: number;
}

// Places every node: one column for each level going right, the points of a branch stacked, and a branch centred on them.
export function layoutTree(tree: MapTree): MapLayout {
  const placed: PlacedNode[] = [];

  const heightOf = (lines: string[]) => lines.length * LINE_HEIGHT + PADDING_Y * 2;

  // Returns the height the subtree takes; fills in y once the top of the subtree is known.
  const measure = (node: MapNode): number => {
    const own = heightOf(wrapText(node.text));
    if (node.children.length === 0) return own;
    const kids = node.children.reduce((sum, child) => sum + measure(child), 0) + ROW_GAP * (node.children.length - 1);
    return Math.max(own, kids);
  };

  const heights = new Map<number, number>();
  const measureAll = (node: MapNode) => {
    heights.set(node.id, measure(node));
    node.children.forEach(measureAll);
  };
  measureAll(tree.root);

  const place = (node: MapNode, depth: number, top: number, parent: number | null) => {
    const lines = wrapText(node.text);
    const height = heightOf(lines);
    const span = heights.get(node.id) ?? height;
    const index = placed.length;
    const entry: PlacedNode = {
      node,
      depth,
      x: MARGIN + depth * (NODE_WIDTH + COLUMN_GAP),
      y: top + (span - height) / 2,
      width: NODE_WIDTH,
      height,
      lines,
      parent,
    };
    placed.push(entry);
    if (node.children.length) {
      const kidsHeight = node.children.reduce((sum, child) => sum + (heights.get(child.id) ?? 0), 0) + ROW_GAP * (node.children.length - 1);
      let cursor = top + (span - kidsHeight) / 2;
      for (const child of node.children) {
        place(child, depth + 1, cursor, index);
        cursor += (heights.get(child.id) ?? 0) + ROW_GAP;
      }
      // the node sits level with the middle of its children
      const first = placed.find((p) => p.node === node.children[0]);
      const last = placed.find((p) => p.node === node.children[node.children.length - 1]);
      if (first && last) entry.y = (first.y + last.y + last.height) / 2 - height / 2;
    }
  };
  place(tree.root, 0, MARGIN, null);

  const width = Math.max(...placed.map((p) => p.x + p.width)) + MARGIN;
  const height = Math.max(...placed.map((p) => p.y + p.height)) + MARGIN;
  return { nodes: placed, width, height };
}

// The line from a node to its parent: a smooth curve from the parent's right edge to the node's left edge.
export function edgePath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

// ---- a standalone picture (SVG / PNG) --------------------------------------------------------------------------------

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Always drawn on white in the ink-and-blue of the site, so the picture reads the same pasted into a document or a post.
const PALETTE = {
  background: "#ffffff",
  ink: "#222222",
  accent: "#1f4e79",
  accentFg: "#ffffff",
  branchFill: "#e3ecf5",
  leafFill: "#f5f4ec",
  line: "#8a9bb0",
};

export function toSvg(layout: MapLayout, title: string): string {
  const { nodes, width, height } = layout;
  const edges = nodes
    .filter((n) => n.parent !== null)
    .map((n) => `<path d="${edgePath(nodes[n.parent as number], n)}" fill="none" stroke="${PALETTE.line}" stroke-width="1.5"/>`)
    .join("");
  const boxes = nodes
    .map((n) => {
      const root = n.node.kind === "root";
      const branch = n.node.kind === "branch";
      const fill = root ? PALETTE.accent : branch ? PALETTE.branchFill : PALETTE.leafFill;
      const stroke = root || branch ? PALETTE.accent : PALETTE.line;
      const color = root ? PALETTE.accentFg : PALETTE.ink;
      const weight = root || branch ? 600 : 400;
      const text = n.lines
        .map(
          (line, i) =>
            `<text x="${n.x + 12}" y="${n.y + PADDING_Y + LINE_HEIGHT * (i + 0.78)}" fill="${color}" font-weight="${weight}">${escapeXml(line)}</text>`,
        )
        .join("");
      return `<g><title>${escapeXml(n.node.text)}</title><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${root || branch ? 1.5 : 1}"/>${text}</g>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" ` +
    `font-family="Georgia, 'Times New Roman', serif" font-size="14">` +
    `<title>${escapeXml(title)}</title><rect width="100%" height="100%" fill="${PALETTE.background}"/>${edges}${boxes}</svg>`
  );
}

// ---- which passage a point came from ----------------------------------------------------------------------------------

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// The sentence of the proof check (a summary sentence compared with the document) that a point of the map is: the same words,
// one inside the other (a bullet may hold two sentences), or failing that the closest in words. Null if none is close.
export function sentenceForPoint(point: string, sentences: ProofSentence[]): ProofSentence | null {
  const wanted = simplify(point);
  if (!wanted) return null;
  const keyed = sentences.map((s) => ({ s, key: simplify(s.text) })).filter((entry) => entry.key);
  const same = keyed.find((entry) => entry.key === wanted);
  if (same) return same.s;
  const inside = keyed.find((entry) => entry.key.length >= 12 && (wanted.includes(entry.key) || entry.key.includes(wanted)));
  if (inside) return inside.s;
  const words = new Set(wanted.split(" ").filter((w) => w.length > 2));
  let best: { s: ProofSentence; score: number } | null = null;
  for (const entry of keyed) {
    const score = overlap(words, new Set(entry.key.split(" ").filter((w) => w.length > 2)));
    if (score >= 0.7 && (!best || score > best.score)) best = { s: entry.s, score };
  }
  return best?.s ?? null;
}
