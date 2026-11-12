"use client";
/**
 * Structure-preserving email editor.
 *
 * TEXT is edited directly in the preview (contenteditable on that block only). If only text
 * changed, the save sends the new text runs and the server rewrites text nodes only, so every
 * surrounding style, colour, font, link and merge field stays exactly as stored. If the browser's
 * edit changed the formatting (e.g. an emptied <span> disappeared), the editor shows exactly what
 * was removed and the user must choose: undo, keep the change, or edit the HTML source. The
 * formatting toolbar (TipTap) is an explicit conversion with a preview of what it removes.
 *
 * The preview iframe is sandboxed (no scripts run inside it); this component reads and edits its
 * same-origin DOM. Saving sends edit operations; the server validates, sanitizes and stores a new
 * version.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditOp, Region } from "../../../lib/templates/editable";
import { describeFormat, formatDiff, sameTags, textStructure, type FormatDiff } from "../../../lib/templates/text-runs";
import { saveEditsAction } from "../../templates-actions";
import { richTextRoundTrip } from "./rich-text-extensions";
import { RichTextField } from "./rich-text-field";

type Props = {
  templateId: string;
  versionId: string;
  versionNo: number;
  regions: Region[];
  recipients: Array<{ id: string; label: string }>;
  mergeFields: string[];
};

type Mode = "inplace" | "rich" | "source";
type Status = "text-only" | "added" | "loss" | "accepted";
type TextState = { mode: Mode; current: string; status: Status | null; diff: FormatDiff | null };

const MERGE_SNIPPETS: Record<string, string> = {
  greeting_name: '{{ greeting_name | default: "Quý khách" }}',
  full_name: '{{ full_name | default: "Quý khách" }}',
  company: '{{ company | default: "quý công ty" }}',
  email: "{{ email }}",
  unsubscribe_url: "{{ unsubscribe_url }}",
};

const EDITOR_ATTR = /^(data-emt-selected|contenteditable|spellcheck)$/i;
const TEXT_SEL = '[data-emt-id^="t"]';

/** A block's inner HTML without editor-state attributes (region ids of nested links are kept). */
function innerFor(el: Element): string {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll("*").forEach((x) => {
    for (const a of [...x.attributes]) if (EDITOR_ATTR.test(a.name)) x.removeAttribute(a.name);
  });
  return c.innerHTML;
}

function withoutIds(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("[data-emt-id]").forEach((x) => x.removeAttribute("data-emt-id"));
  return t.innerHTML;
}

function insertAtSelection(doc: Document, host: Element, node: Node, saved: Range | null) {
  const sel = doc.getSelection();
  let r: Range | null = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || !host.contains(r.startContainer)) r = saved && host.contains(saved.startContainer) ? saved : null;
  if (!r) {
    host.appendChild(node);
    return;
  }
  r.deleteContents();
  r.insertNode(node);
  r.setStartAfter(node);
  r.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function TemplateEditor(p: Props) {
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);
  const sourceBox = useRef<HTMLTextAreaElement>(null);
  const orig = useRef<Record<string, string>>({});
  const lastRange = useRef<{ id: string; range: Range } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ops, setOps] = useState<Record<string, EditOp>>({});
  const [texts, setTexts] = useState<Record<string, TextState>>({});
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const [parents, setParents] = useState<Record<string, string>>({});
  const [convert, setConvert] = useState<{ id: string; base: string; diff: FormatDiff } | null>(null);
  const [mode, setMode] = useState<string>("edit");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [broken, setBroken] = useState<number | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [insert, setInsert] = useState<string | null>(null);
  const [reload, setReload] = useState(0); // bump to reload the preview (reverts painted attributes)
  const byId = useMemo(() => Object.fromEntries(p.regions.map((r) => [r.id, r])), [p.regions]);
  const region = selected ? byId[selected] : null;
  const textsRef = useRef(texts);
  useEffect(() => {
    textsRef.current = texts;
  }, [texts]);

  const src = mode === "edit" ? `/templates/${p.templateId}/preview?v=${p.versionId}&mode=edit` : `/templates/${p.templateId}/preview?v=${p.versionId}&mode=recipient&r=${encodeURIComponent(mode)}`;
  const docEl = useCallback((id: string) => frame.current?.contentDocument?.querySelector<HTMLElement>(`[data-emt-id="${id}"]`) ?? null, []);

  const setOp = useCallback((id: string, op: EditOp | null) => {
    setOps((o) => {
      const n = { ...o };
      if (op) n[id] = op;
      else delete n[id];
      return n;
    });
  }, []);
  const mergeOp = (op: EditOp) => setOps((o) => ({ ...o, [op.id]: { ...(o[op.id] ?? {}), ...op } as EditOp }));

  /** Re-evaluate an in-place edit of text block `id` from the live preview DOM. */
  const recompute = useCallback(
    (id: string) => {
      const el = docEl(id);
      const base = orig.current[id];
      if (!el || base === undefined) return;
      const cur = innerFor(el);
      const prev = textsRef.current[id];
      if (cur === base) {
        setOp(id, null);
        setTexts((t) => {
          const n = { ...t };
          delete n[id];
          return n;
        });
        return;
      }
      const s0 = textStructure(base);
      const s1 = textStructure(cur);
      let status: Status;
      let diff: FormatDiff | null = null;
      if (sameTags(s0.tags, s1.tags)) {
        status = "text-only";
        setOp(id, { id, kind: "text-runs", tags: s1.tags, gaps: s1.gaps });
      } else {
        diff = formatDiff(base, cur);
        const accepted = prev?.status === "accepted";
        status = diff.removed.length ? (accepted ? "accepted" : "loss") : "added";
        if (status === "loss") setOp(id, null);
        else setOp(id, { id, kind: "text", html: cur, mode: "inplace", acceptFormatChange: status === "accepted" });
      }
      setTexts((t) => ({ ...t, [id]: { mode: "inplace", current: cur, status, diff } }));
    },
    [docEl, setOp],
  );
  const recomputeRef = useRef(recompute);
  useEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);

  // Show pending image/link/button edits and toolbar/source text inside the preview (display only).
  const paint = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc || mode !== "edit") return;
    for (const op of Object.values(ops)) {
      const el = doc.querySelector<HTMLElement>(`[data-emt-id="${op.id}"]`);
      if (!el) continue;
      if (op.kind === "image") {
        if (op.src !== undefined) el.setAttribute("src", op.src);
        if (op.alt !== undefined) el.setAttribute("alt", op.alt);
      }
      if ((op.kind === "link" || op.kind === "button") && op.href !== undefined) el.setAttribute("href", op.href);
      if (op.kind === "button" && op.text !== undefined) {
        let t: Element = el;
        while (t.children.length === 1) t = t.children[0];
        if (t.textContent !== op.text) t.textContent = op.text;
      }
    }
    for (const [id, st] of Object.entries(texts)) {
      if (st.mode === "inplace") continue; // the preview DOM itself is being edited
      const el = doc.querySelector<HTMLElement>(`[data-emt-id="${id}"]`);
      if (el && el.innerHTML !== st.current) el.innerHTML = st.current;
    }
    doc.querySelectorAll("[data-emt-selected]").forEach((x) => x.removeAttribute("data-emt-selected"));
    if (selected) doc.querySelector(`[data-emt-id="${selected}"]`)?.setAttribute("data-emt-selected", "");
  }, [ops, texts, selected, mode]);

  useEffect(() => paint(), [paint]);

  const inited = useRef(new WeakSet<Document>());
  const onLoad = useCallback(() => {
    const f = frame.current;
    const doc = f?.contentDocument;
    if (!f || !doc || doc.URL === "about:blank" || inited.current.has(doc)) return;
    inited.current.add(doc); // once per loaded document (onLoad and the hydration check may both call this)
    const imgs = [...doc.images];
    const settled = (img: HTMLImageElement) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          });
    Promise.all(imgs.map(settled)).then(() => setBroken(imgs.filter((img) => img.naturalWidth === 0).length));
    if (mode === "edit") {
      const blockedNow: Record<string, boolean> = {};
      const parentsNow: Record<string, string> = {};
      doc.querySelectorAll<HTMLElement>(TEXT_SEL).forEach((el) => {
        const id = el.getAttribute("data-emt-id")!;
        orig.current[id] = innerFor(el);
        el.querySelectorAll("[data-emt-id]").forEach((n) => (parentsNow[n.getAttribute("data-emt-id")!] = id));
        const r = byId[id];
        // In-place editing only when the browser sees exactly the structure the server stored.
        const ok = !!r && !r.hidden && sameTags(textStructure(orig.current[id]).tags, r.tags ?? []);
        if (!ok) {
          blockedNow[id] = true;
          return;
        }
        const st = textsRef.current[id];
        if (st) el.innerHTML = st.current; // re-show unsaved edits after the preview reloads
        if (!st || st.mode === "inplace") {
          el.setAttribute("contenteditable", "plaintext-only");
          if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
          el.setAttribute("spellcheck", "false");
        }
      });
      setBlocked(blockedNow);
      setParents(parentsNow);
      const hostOf = (t: EventTarget | null) => (t as Element | null)?.closest?.<HTMLElement>(TEXT_SEL) ?? null;
      doc.addEventListener("click", (e) => {
        const t = (e.target as Element).closest?.("[data-emt-id]");
        e.preventDefault();
        if (t) setSelected(t.getAttribute("data-emt-id"));
      });
      doc.addEventListener("input", (e) => {
        const h = hostOf(e.target);
        if (h) recomputeRef.current(h.getAttribute("data-emt-id")!);
      });
      doc.addEventListener("paste", (e) => {
        const h = hostOf(e.target);
        if (!h || !h.isContentEditable) return;
        e.preventDefault(); // plain text only: pasted markup can never alter the template
        insertAtSelection(doc, h, doc.createTextNode(e.clipboardData?.getData("text/plain") ?? ""), null);
        recomputeRef.current(h.getAttribute("data-emt-id")!);
      });
      doc.addEventListener("keydown", (e) => {
        const h = hostOf(e.target);
        if (!h || !h.isContentEditable) return;
        if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) e.preventDefault();
        if (e.key === "Enter") {
          e.preventDefault();
          insertAtSelection(doc, h, doc.createElement("br"), null);
          recomputeRef.current(h.getAttribute("data-emt-id")!);
        }
      });
      doc.addEventListener("drop", (e) => e.preventDefault());
      doc.addEventListener("selectionchange", () => {
        const sel = doc.getSelection();
        if (!sel || !sel.rangeCount) return;
        const r = sel.getRangeAt(0);
        const start = r.startContainer.nodeType === 1 ? (r.startContainer as Element) : r.startContainer.parentElement;
        const h = start?.closest(TEXT_SEL);
        if (h) lastRange.current = { id: h.getAttribute("data-emt-id")!, range: r.cloneRange() };
      });
      paint();
    }
    f.style.height = `${Math.max(400, doc.documentElement.scrollHeight + 4)}px`;
  }, [mode, paint, byId]);

  // The preview can finish loading before React hydrates (then onLoad never fires): initialise it.
  useEffect(() => {
    if (frame.current?.contentDocument?.readyState === "complete") onLoad();
  }, [onLoad]);

  useEffect(() => {
    if (mode === "edit") return;
    let live = true;
    fetch(src).then((r) => live && setMissing(r.headers.get("X-Missing-Without-Fallback") ?? ""));
    return () => {
      live = false;
    };
  }, [src, mode]);

  /** Drop pending edits of links inside a block whose HTML is now edited as a whole. */
  const dropNested = (id: string) =>
    setOps((o) => {
      const n = { ...o };
      for (const [k, par] of Object.entries(parents)) if (par === id) delete n[k];
      return n;
    });

  function undoBlock(id: string) {
    const el = docEl(id);
    if (el && orig.current[id] !== undefined) {
      el.innerHTML = orig.current[id];
      if (!blocked[id]) el.setAttribute("contenteditable", "plaintext-only");
    }
    setOp(id, null);
    setTexts((t) => {
      const n = { ...t };
      delete n[id];
      return n;
    });
    if (convert?.id === id) setConvert(null);
  }

  function keepChange(id: string) {
    const st = texts[id];
    if (!st) return;
    setTexts((t) => ({ ...t, [id]: { ...st, status: "accepted" } }));
    setOp(id, { id, kind: "text", html: st.current, mode: "inplace", acceptFormatChange: true });
  }

  function setSource(id: string, html: string) {
    const d = formatDiff(withoutIds(orig.current[id] ?? ""), html);
    setTexts((t) => ({ ...t, [id]: { mode: "source", current: html, status: d.removed.length ? "accepted" : d.textOnly ? "text-only" : "added", diff: d } }));
    setOp(id, { id, kind: "text", html, mode: "source", acceptFormatChange: true });
  }

  function toSource(id: string) {
    const el = docEl(id);
    const html = withoutIds(el ? innerFor(el) : (orig.current[id] ?? ""));
    el?.removeAttribute("contenteditable");
    dropNested(id);
    setConvert(null);
    if (html === withoutIds(orig.current[id] ?? "")) setTexts((t) => ({ ...t, [id]: { mode: "source", current: html, status: null, diff: null } }));
    else setSource(id, html);
  }

  function askRich(id: string) {
    const el = docEl(id);
    const base = withoutIds(el ? innerFor(el) : (orig.current[id] ?? ""));
    const diff = formatDiff(withoutIds(orig.current[id] ?? ""), richTextRoundTrip(base));
    if (diff.removed.length) setConvert({ id, base, diff });
    else enterRich(id, base);
  }

  function enterRich(id: string, base: string) {
    docEl(id)?.removeAttribute("contenteditable");
    dropNested(id);
    setConvert(null);
    setTexts((t) => ({ ...t, [id]: { mode: "rich", current: base, status: t[id]?.status ?? null, diff: t[id]?.diff ?? null } }));
  }

  function onRich(id: string, html: string) {
    const d = formatDiff(withoutIds(orig.current[id] ?? ""), html);
    setTexts((t) => ({ ...t, [id]: { mode: "rich", current: html, status: d.removed.length ? "accepted" : d.textOnly ? "text-only" : "added", diff: d } }));
    setOp(id, { id, kind: "text", html, mode: "rich", acceptFormatChange: true });
  }

  function toInplace(id: string) {
    // Leaving the toolbar/source view: start again from the stored block (explicit undo).
    undoBlock(id);
  }

  function insertMerge(id: string, snippet: string) {
    const st = texts[id];
    const m = st?.mode ?? "inplace";
    if (m === "rich") return setInsert(snippet);
    if (m === "source") {
      const box = sourceBox.current;
      const cur = st?.current ?? "";
      const at = box ? box.selectionStart : cur.length;
      return setSource(id, cur.slice(0, at) + snippet + cur.slice(at));
    }
    const el = docEl(id);
    const doc = frame.current?.contentDocument;
    if (!el || !doc || blocked[id]) return;
    insertAtSelection(doc, el, doc.createTextNode(snippet), lastRange.current?.id === id ? lastRange.current.range : null);
    el.focus(); // keep typing after the inserted field (the caret is placed after it)
    recompute(id);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    const r = await saveEditsAction(p.templateId, p.versionId, Object.values(ops));
    setSaving(false);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return;
    }
    setMsg({ ok: true, text: `Saved as version ${r.versionNo}.` });
    setOps({});
    setTexts({});
    setSelected(null);
    router.push(`/templates/${p.templateId}?v=${r.versionId}`);
    router.refresh();
  }

  const pendingField = (id: string, k: "src" | "alt" | "href" | "text") => (ops[id] as Record<string, unknown> | undefined)?.[k] as string | undefined;
  const width = device === "desktop" ? 640 : 375;
  const visibleRegions = p.regions.filter((r) => !(r.kind === "link" && r.label === ""));
  const unresolved = Object.entries(texts).filter(([, s]) => s.status === "loss").map(([id]) => id);
  const pending = Object.keys(ops).length;
  const textId = region?.kind === "text" ? region.id : null;
  const st = textId ? texts[textId] : undefined;
  const tMode: Mode = st?.mode ?? (textId && blocked[textId] ? "source" : "inplace");
  const parentOfSelected = selected ? parents[selected] : undefined;
  const parentMode = parentOfSelected ? texts[parentOfSelected]?.mode : undefined;

  return (
    <section className="card editor" data-testid="editor">
      <div className="row editor-toolbar">
        <label>
          Preview
          <select
            value={mode}
            onChange={(e) => {
              setMissing(null);
              setMode(e.target.value);
            }}
            data-testid="preview-mode"
          >
            <option value="edit">Edit (merge fields shown as written)</option>
            {p.recipients.map((r) => (
              <option key={r.id} value={r.id}>
                As recipient — {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button type="button" className={`btn ${device === "desktop" ? "primary" : ""}`} onClick={() => setDevice("desktop")} data-testid="device-desktop">
            Desktop 640px
          </button>
          <button type="button" className={`btn ${device === "mobile" ? "primary" : ""}`} onClick={() => setDevice("mobile")} data-testid="device-mobile">
            Mobile 375px
          </button>
        </div>
        <span className="muted small" data-testid="broken-images">
          {broken === null ? "" : broken === 0 ? "All images loaded in this browser preview" : `${broken} image(s) failed to load in this browser preview`}
        </span>
        {missing !== null && (
          <span className="small" data-testid="missing-fallback">
            {missing ? `⚠ Missing values without fallback: ${missing}` : "✓ No missing values without fallback for this recipient"}
          </span>
        )}
      </div>
      <div className="editor-body">
        <div className="frame-wrap" style={{ width }}>
          <iframe ref={frame} key={`${src}#${reload}`} src={src} sandbox="allow-same-origin" title="Email preview" onLoad={onLoad} style={{ width, border: "1px solid var(--border)", background: "#fff" }} data-testid="preview-frame" />
          <p className="muted small">Browser preview only (this browser). Not a Gmail, Outlook or phone mail-app rendering.</p>
        </div>
        <aside className="regions">
          <h2 style={{ marginTop: 0 }}>Edit</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Click text in the preview and type. Click an image or link to change it. Only what you edit changes; the rest of the HTML stays exactly as imported.
          </p>
          {mode !== "edit" && <div className="banner warn small">Switch the preview to “Edit” to make changes.</div>}

          {region && mode === "edit" && (
            <div className="card region-form" data-testid="region-form" data-region={region.id}>
              <h3 style={{ marginTop: 0 }}>
                {region.kind === "text" ? "Text" : region.kind === "image" ? "Image" : region.kind === "button" ? "Button" : "Link"} <span className="muted small">{region.id}</span>
                {region.hidden ? " (hidden preview text)" : ""}
              </h3>

              {textId && (
                <>
                  <div className="row mode-tabs" data-testid="text-modes">
                    <button type="button" className={`btn small-btn ${tMode === "inplace" ? "primary" : ""}`} disabled={!!blocked[textId]} onClick={() => tMode !== "inplace" && toInplace(textId)}
                      title={tMode !== "inplace" ? "Discards the toolbar/source changes of this block and returns to editing in the preview" : undefined}
                      data-testid="mode-inplace">
                      Edit in preview
                    </button>
                    <button type="button" className={`btn small-btn ${tMode === "rich" ? "primary" : ""}`} disabled={tMode === "rich"} onClick={() => askRich(textId)} data-testid="mode-rich">
                      Formatting toolbar
                    </button>
                    <button type="button" className={`btn small-btn ${tMode === "source" ? "primary" : ""}`} disabled={tMode === "source"} onClick={() => toSource(textId)} data-testid="mode-source">
                      HTML source
                    </button>
                  </div>

                  {tMode === "inplace" && !blocked[textId] && (
                    <p className="small" style={{ margin: 0 }}>
                      Type directly in the highlighted block in the preview. Only the text changes: styles, colours, fonts, links and merge fields around it are kept. Paste inserts plain text; Enter adds a line break.
                    </p>
                  )}
                  {blocked[textId] && !st && (
                    <div className="banner warn small" data-testid="inplace-blocked">
                      {region.hidden ? "This text is hidden in the email (preview text), so it is edited as HTML source." : "This block cannot be edited safely in the preview; edit it as HTML source."}
                    </div>
                  )}

                  {convert?.id === textId && (
                    <div className="banner warn small" data-testid="convert-confirm">
                      <strong>The formatting toolbar cannot keep everything in this block.</strong> Converting removes:
                      <ul className="plain">
                        {convert.diff.removed.map((f, i) => (
                          <li key={i}>
                            <code>{describeFormat(f)}</code>
                          </li>
                        ))}
                      </ul>
                      You can undo the conversion afterwards. To keep every format, stay with “Edit in preview” or use “HTML source”.
                      <div className="row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn small-btn" onClick={() => enterRich(textId, convert.base)} data-testid="convert-yes">
                          Convert to the formatting toolbar
                        </button>
                        <button type="button" className="btn small-btn" onClick={() => setConvert(null)} data-testid="convert-no">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {tMode === "rich" && <RichTextField key={`${textId}-rich`} initialHtml={st?.current ?? ""} onChange={(html) => onRich(textId, html)} insertText={insert} onInserted={() => setInsert(null)} />}
                  {tMode === "source" && (
                    <>
                      <textarea
                        ref={sourceBox}
                        className="source-box"
                        rows={8}
                        spellCheck={false}
                        value={st?.current ?? withoutIds(orig.current[textId] ?? region.html ?? "")}
                        onChange={(e) => setSource(textId, e.target.value)}
                        data-testid="edit-source"
                      />
                      <p className="muted small" style={{ margin: 0 }}>
                        Inline HTML of this block only. On save, unsafe markup (scripts, event handlers, javascript: links) and block-level tags are removed.
                      </p>
                    </>
                  )}

                  <FormatStatus state={st} />
                  {st?.status === "loss" && (
                    <div className="row" data-testid="loss-actions">
                      <button type="button" className="btn small-btn" onClick={() => undoBlock(textId)} data-testid="undo-block">
                        Undo changes to this block
                      </button>
                      <button type="button" className="btn small-btn" onClick={() => keepChange(textId)} data-testid="keep-format-change">
                        Keep this change
                      </button>
                      <button type="button" className="btn small-btn" onClick={() => toSource(textId)} data-testid="to-source">
                        Edit HTML source instead
                      </button>
                    </div>
                  )}
                  {st && st.status !== "loss" && (
                    <div>
                      <button type="button" className="btn small-btn" onClick={() => undoBlock(textId)} data-testid="undo-block">
                        Undo changes to this block
                      </button>
                    </div>
                  )}

                  <label className="small">
                    Insert merge field {tMode === "inplace" ? "(at the cursor in the preview)" : ""}
                    <select value="" onChange={(e) => e.target.value && insertMerge(textId, MERGE_SNIPPETS[e.target.value] ?? `{{ ${e.target.value} }}`)} data-testid="insert-merge">
                      <option value="">—</option>
                      {p.mergeFields.map((f) => (
                        <option key={f} value={f}>
                          {MERGE_SNIPPETS[f] ?? f}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {region.kind === "image" && (
                <>
                  <label className="small">
                    Image URL (https://…)
                    <input key={`${region.id}-src`} defaultValue={pendingField(region.id, "src") ?? region.src} onChange={(e) => mergeOp({ id: region.id, kind: "image", src: e.target.value })} data-testid="edit-src" />
                  </label>
                  <label className="small">
                    Alt text
                    <input key={`${region.id}-alt`} defaultValue={pendingField(region.id, "alt") ?? region.alt} onChange={(e) => mergeOp({ id: region.id, kind: "image", alt: e.target.value })} data-testid="edit-alt" />
                  </label>
                </>
              )}
              {(region.kind === "link" || region.kind === "button") &&
                (parentOfSelected && parentMode && parentMode !== "inplace" ? (
                  <div className="banner warn small">This link is inside a text block that is being edited with the {parentMode === "rich" ? "formatting toolbar" : "HTML source"}; change it there.</div>
                ) : (
                  <>
                    <label className="small">
                      Destination (https://, mailto:, tel: or a merge field)
                      <input key={`${region.id}-href`} defaultValue={pendingField(region.id, "href") ?? region.href} onChange={(e) => mergeOp({ id: region.id, kind: region.kind as "link", href: e.target.value })} data-testid="edit-href" />
                    </label>
                    {region.kind === "button" && (
                      <label className="small">
                        Button text
                        <input key={`${region.id}-text`} defaultValue={pendingField(region.id, "text") ?? region.text} onChange={(e) => mergeOp({ id: region.id, kind: "button", text: e.target.value })} data-testid="edit-button-text" />
                      </label>
                    )}
                  </>
                ))}
              {parentOfSelected && (
                <button type="button" className="linkish small" onClick={() => setSelected(parentOfSelected)} data-testid="select-parent-text">
                  Edit the surrounding text ({parentOfSelected})
                </button>
              )}
              {ops[region.id] && region.kind !== "text" && (
                <button
                  type="button"
                  className="btn small-btn"
                  onClick={() => {
                    setOp(region.id, null);
                    setReload((n) => n + 1);
                  }}
                  data-testid="undo-region"
                >
                  Undo changes to this {region.kind}
                </button>
              )}
            </div>
          )}

          <details className="small" open>
            <summary>All editable parts ({p.regions.length})</summary>
            <ul className="plain region-list">
              {visibleRegions.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`linkish ${selected === r.id ? "active" : ""}`} onClick={() => setSelected(r.id)} data-testid={`region-${r.id}`}>
                    <span className="pill">{r.kind}</span> {r.id} {texts[r.id]?.status === "loss" ? "⚠ needs a choice" : ops[r.id] ? "• edited" : ""} — <span className="muted">{(r.label || "").slice(0, 50)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>

          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={!pending || saving || unresolved.length > 0} onClick={save} data-testid="save-version">
              {saving ? "Saving…" : `Save as new version (${pending} change${pending === 1 ? "" : "s"})`}
            </button>
            {(pending > 0 || Object.keys(texts).length > 0) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTexts({});
                  setOps({});
                  setConvert(null);
                  setReload((n) => n + 1);
                }}
                data-testid="discard-all"
              >
                Discard all
              </button>
            )}
          </div>
          {unresolved.length > 0 && (
            <p className="small" style={{ color: "var(--bad)" }} data-testid="save-blocked">
              Choose what to do with the formatting change in {unresolved.join(", ")} before saving.
            </p>
          )}
          {msg && (
            <p role={msg.ok ? "status" : "alert"} style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }} data-testid="save-result">
              {msg.text}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

function FormatStatus({ state }: { state?: TextState }) {
  if (!state || !state.status) return null;
  const list = (items: FormatDiff["removed"]) => (
    <ul className="plain">
      {items.map((f, i) => (
        <li key={i}>
          <code>{describeFormat(f)}</code>
        </li>
      ))}
    </ul>
  );
  if (state.status === "text-only")
    return (
      <p className="small" style={{ color: "var(--ok)", margin: 0 }} data-testid="format-status" data-state="text-only">
        ✓ Only the text changed. All formatting is kept.
      </p>
    );
  if (state.status === "added")
    return (
      <div className="small" data-testid="format-status" data-state="added">
        ✓ Nothing removed. Formatting added: {list(state.diff?.added ?? [])}
      </div>
    );
  if (state.status === "loss")
    return (
      <div className="banner bad small" data-testid="format-status" data-state="loss">
        <strong>This change removes formatting:</strong>
        {list(state.diff?.removed ?? [])}
        Choose: undo it, keep it, or edit the HTML source.
      </div>
    );
  return (
    <div className="banner warn small" data-testid="format-status" data-state="accepted">
      Formatting removed (you chose to keep this change):
      {list(state.diff?.removed ?? [])}
    </div>
  );
}
