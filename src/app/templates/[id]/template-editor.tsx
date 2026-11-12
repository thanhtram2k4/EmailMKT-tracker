"use client";
/**
 * Candidate (a): structure-preserving click-to-edit editor.
 * The preview iframe is sandboxed (no scripts run inside it); this component reads/annotates its
 * same-origin DOM only to select regions and to show unsaved edits. Saving sends edit operations
 * to the server, which applies them to the stored HTML and creates a new version.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditOp, Region } from "../../../lib/templates/editable";
import { saveEditsAction } from "../../templates-actions";
import { RichTextField } from "./rich-text-field";

type Props = {
  templateId: string;
  versionId: string;
  versionNo: number;
  regions: Region[];
  recipients: Array<{ id: string; label: string }>;
  mergeFields: string[];
};

const MERGE_SNIPPETS: Record<string, string> = {
  greeting_name: '{{ greeting_name | default: "Quý khách" }}',
  full_name: '{{ full_name | default: "Quý khách" }}',
  company: '{{ company | default: "quý công ty" }}',
  email: "{{ email }}",
  unsubscribe_url: "{{ unsubscribe_url }}",
};

export function TemplateEditor(p: Props) {
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ops, setOps] = useState<Record<string, EditOp>>({});
  const [mode, setMode] = useState<string>("edit");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [broken, setBroken] = useState<number | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [insert, setInsert] = useState<string | null>(null);
  const byId = useMemo(() => Object.fromEntries(p.regions.map((r) => [r.id, r])), [p.regions]);
  const region = selected ? byId[selected] : null;
  const pending = Object.keys(ops).length;

  const src = mode === "edit" ? `/templates/${p.templateId}/preview?v=${p.versionId}&mode=edit` : `/templates/${p.templateId}/preview?v=${p.versionId}&mode=recipient&r=${encodeURIComponent(mode)}`;

  // Show unsaved edits inside the preview DOM (display only).
  const paint = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc || mode !== "edit") return;
    for (const op of Object.values(ops)) {
      const el = doc.querySelector<HTMLElement>(`[data-emt-id="${op.id}"]`);
      if (!el) continue;
      if (op.kind === "text") el.innerHTML = op.html;
      if (op.kind === "image") {
        if (op.src !== undefined) el.setAttribute("src", op.src);
        if (op.alt !== undefined) el.setAttribute("alt", op.alt);
      }
      if ((op.kind === "link" || op.kind === "button") && op.href !== undefined) el.setAttribute("href", op.href);
      if (op.kind === "button" && op.text !== undefined) {
        let t: Element = el;
        while (t.children.length === 1) t = t.children[0];
        t.textContent = op.text;
      }
    }
    doc.querySelectorAll("[data-emt-selected]").forEach((x) => x.removeAttribute("data-emt-selected"));
    if (selected) doc.querySelector(`[data-emt-id="${selected}"]`)?.setAttribute("data-emt-selected", "");
  }, [ops, selected, mode]);

  useEffect(() => paint(), [paint]);

  const onLoad = useCallback(() => {
    const f = frame.current;
    const doc = f?.contentDocument;
    if (!f || !doc) return;
    f.style.height = `${Math.max(400, doc.documentElement.scrollHeight + 4)}px`;
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
      doc.addEventListener("click", (e) => {
        const t = (e.target as Element).closest("[data-emt-id]");
        e.preventDefault();
        if (t) setSelected(t.getAttribute("data-emt-id"));
      });
      paint();
    }
  }, [mode, paint]);

  useEffect(() => {
    if (mode === "edit") return;
    let live = true;
    fetch(src).then((r) => live && setMissing(r.headers.get("X-Missing-Without-Fallback") ?? ""));
    return () => {
      live = false;
    };
  }, [src, mode]);

  const setOp = (op: EditOp) => setOps((o) => ({ ...o, [op.id]: { ...(o[op.id] ?? {}), ...op } as EditOp }));

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
    setSelected(null);
    router.push(`/templates/${p.templateId}?v=${r.versionId}`);
    router.refresh();
  }

  const width = device === "desktop" ? 640 : 375;
  const visibleRegions = p.regions.filter((r) => !(r.kind === "link" && r.label === ""));

  return (
    <section className="card editor" data-testid="editor">
      <div className="row editor-toolbar">
        <label>
          Preview
          <select value={mode} onChange={(e) => {
              setMissing(null);
              setMode(e.target.value);
            }}
            data-testid="preview-mode">
            <option value="edit">Edit mode (raw merge fields)</option>
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
          <iframe ref={frame} key={src} src={src} sandbox="allow-same-origin" title="Template preview" onLoad={onLoad} style={{ width, border: "1px solid var(--border)", background: "#fff" }} data-testid="preview-frame" />
          <p className="muted small">Browser preview (Chromium/your browser). Not a Gmail, Outlook or mobile mail-app rendering.</p>
        </div>
        <aside className="regions">
          <h2 style={{ marginTop: 0 }}>Editable regions ({p.regions.length})</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Click an element in the preview or pick it below. Only the edited element changes; the rest of the HTML is kept as imported.
          </p>
          {mode !== "edit" && <div className="banner warn small">Switch the preview to “Edit mode” to edit.</div>}
          {region && mode === "edit" && (
            <div className="card region-form" data-testid="region-form">
              <h3 style={{ marginTop: 0 }}>
                {region.kind} {region.id}
                {region.hidden ? " (hidden preheader)" : ""}
              </h3>
              {region.kind === "text" && (
                <>
                  {!!region.unsupportedInline?.length && (
                    <div className="banner warn small" data-testid="unsupported-inline">
                      Editing this block will drop formatting the rich-text editor cannot keep: {region.unsupportedInline.join("; ")}
                    </div>
                  )}
                  <RichTextField key={region.id} initialHtml={region.html ?? ""} onChange={(html) => setOp({ id: region.id, kind: "text", html })} insertText={insert} onInserted={() => setInsert(null)} />
                  <label className="small">
                    Insert merge field
                    <select value="" onChange={(e) => e.target.value && setInsert(MERGE_SNIPPETS[e.target.value] ?? `{{ ${e.target.value} }}`)} data-testid="insert-merge">
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
                    <input defaultValue={region.src} onChange={(e) => setOp({ id: region.id, kind: "image", src: e.target.value })} data-testid="edit-src" />
                  </label>
                  <label className="small">
                    Alt text
                    <input defaultValue={region.alt} onChange={(e) => setOp({ id: region.id, kind: "image", alt: e.target.value })} data-testid="edit-alt" />
                  </label>
                </>
              )}
              {(region.kind === "link" || region.kind === "button") && (
                <label className="small">
                  Destination (https://, mailto:, tel: or a merge field)
                  <input defaultValue={region.href} onChange={(e) => setOp({ id: region.id, kind: region.kind as "link", href: e.target.value })} data-testid="edit-href" />
                </label>
              )}
              {region.kind === "button" && (
                <label className="small">
                  Button text
                  <input defaultValue={region.text} onChange={(e) => setOp({ id: region.id, kind: "button", text: e.target.value })} data-testid="edit-button-text" />
                </label>
              )}
            </div>
          )}
          <ul className="plain region-list">
            {visibleRegions.map((r) => (
              <li key={r.id}>
                <button type="button" className={`linkish ${selected === r.id ? "active" : ""}`} onClick={() => setSelected(r.id)} data-testid={`region-${r.id}`}>
                  <span className="pill">{r.kind}</span> {r.id} {ops[r.id] ? "• edited" : ""} — <span className="muted">{(r.label || "").slice(0, 50)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={!pending || saving} onClick={save} data-testid="save-version">
              {saving ? "Saving…" : `Save as new version (${pending} edit${pending === 1 ? "" : "s"})`}
            </button>
            {pending > 0 && (
              <button type="button" className="btn" onClick={() => setOps({})}>
                Discard
              </button>
            )}
          </div>
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
