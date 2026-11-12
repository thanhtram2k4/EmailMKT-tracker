/**
 * Formatting-preserving text edits (shared by the browser editor and the server).
 *
 * A text block's inner HTML is described as:
 *   - `tags`: its elements in document order with their depth (the formatting skeleton), and
 *   - `gaps`: for the block root and each element, the decoded text in every "gap" between its
 *     child elements (children + 1 gaps).
 * If an edit leaves `tags` unchanged, it is a TEXT-ONLY edit: the server rewrites only text nodes
 * and every element, attribute, style and merge-field attribute stays byte-for-byte as stored.
 * If `tags` changed (e.g. the browser removed an emptied <span>), the editor shows exactly which
 * formatting was removed/added and requires an explicit choice (undo, keep, or HTML source).
 *
 * Uses htmlparser2 only (no DOM), so the browser and the server compute identical structures.
 */
import { parseDocument } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";

export type TextStructure = { tags: string[]; gaps: string[][] };

const isEl = (n: AnyNode): n is Element => n.type === "tag" || n.type === "script" || n.type === "style";

/** Editor-only attributes never count as formatting. */
const IGNORED_ATTR = /^(data-emt-|contenteditable$|spellcheck$)/i;

function walk(root: { children: AnyNode[] }, visit: (el: { children: AnyNode[] }, name: string, depth: number) => void, name = "#root", depth = 0) {
  visit(root, name, depth);
  for (const c of root.children) if (isEl(c)) walk(c, visit, c.name.toLowerCase(), depth + 1);
}

export function textStructure(innerHtml: string): TextStructure {
  const doc = parseDocument(innerHtml, { decodeEntities: true });
  const tags: string[] = [];
  const gaps: string[][] = [];
  walk(doc, (el, name, depth) => {
    // depth:name in document order fixes the tree shape, so gaps align on both sides.
    if (name !== "#root") tags.push(`${depth}:${name}`);
    const g: string[] = [""];
    for (const c of el.children) {
      if (c.type === "text") g[g.length - 1] += (c as unknown as { data: string }).data.replace(/\x0d\x0a?/g, "\x0a");
      else if (isEl(c)) g.push("");
    }
    gaps.push(g);
  });
  return { tags, gaps };
}

export const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Escape text for an HTML text node (no markup can be introduced by a text-only edit). */
export function encodeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}

export type FormatEl = { tag: string; attrs: string; text: string };
export type FormatDiff = { textOnly: boolean; removed: FormatEl[]; added: FormatEl[] };

function textOf(n: AnyNode): string {
  if (n.type === "text") return (n as unknown as { data: string }).data;
  if (isEl(n)) return n.children.map(textOf).join("");
  return "";
}

/** Decoded text of an HTML fragment in document order (e.g. for labels). */
export function plainTextOf(innerHtml: string): string {
  return parseDocument(innerHtml, { decodeEntities: true }).children.map(textOf).join("");
}

function formatEls(innerHtml: string): FormatEl[] {
  const doc = parseDocument(innerHtml, { decodeEntities: true });
  const out: FormatEl[] = [];
  walk(doc, (el, name) => {
    if (name === "#root") return;
    const e = el as Element;
    // href/src are content, edited through validated link/image operations, not formatting.
    const attrs = Object.entries(e.attribs ?? {})
      .filter(([k]) => !IGNORED_ATTR.test(k) && k !== "href" && k !== "src")
      .map(([k, v]) => `${k.toLowerCase()}="${String(v).replace(/\s+/g, " ").trim()}"`)
      .sort()
      .join(" ");
    out.push({ tag: name, attrs, text: textOf(e).replace(/\s+/g, " ").trim().slice(0, 40) });
  });
  return out;
}

const sig = (f: FormatEl) => `${f.tag} ${f.attrs}`;

/** What formatting an edit removed or added (multiset comparison of element signatures). */
export function formatDiff(beforeInner: string, afterInner: string): FormatDiff {
  const a = formatEls(beforeInner);
  const b = formatEls(afterInner);
  const pool = new Map<string, FormatEl[]>();
  for (const f of b) pool.set(sig(f), [...(pool.get(sig(f)) ?? []), f]);
  const removed: FormatEl[] = [];
  for (const f of a) {
    const list = pool.get(sig(f));
    if (list?.length) list.shift();
    else removed.push(f);
  }
  const added = [...pool.values()].flat();
  const textOnly = a.length === b.length && a.every((f, i) => sig(f) === sig(b[i]));
  return { textOnly, removed, added };
}

export function describeFormat(f: FormatEl): string {
  return `<${f.tag}${f.attrs ? " " + f.attrs : ""}>${f.text ? ` around “${f.text}”` : ""}`;
}
