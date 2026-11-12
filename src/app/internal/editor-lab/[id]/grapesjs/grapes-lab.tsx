"use client";
import "grapesjs/dist/css/grapes.min.css";
import type { Editor } from "grapesjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { saveGrapesAction } from "../../actions";

type Props = { templateId: string; versionId: string; body: string; css: string; head: string; doctype: string; htmlAttrs: string; bodyAttrs: string };

declare global {
  interface Window {
    __gjs?: { editor: Editor; exportHtml: () => string; ready: boolean };
  }
}

export function GrapesLab(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState("Loading GrapesJS…");
  const router = useRouter();

  const exportHtml = () => {
    const ed = editorRef.current!;
    const body = ed.runCommand("gjs-get-inlined-html") as string;
    return `${p.doctype}\n<html${p.htmlAttrs ? " " + p.htmlAttrs : ""}>\n<head>${p.head}</head>\n<body${p.bodyAttrs ? " " + p.bodyAttrs : ""}>\n${body}\n</body>\n</html>\n`;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const grapesjs = (await import("grapesjs")).default;
      const newsletter = (await import("grapesjs-preset-newsletter")).default;
      if (cancelled || !ref.current) return;
      const editor = grapesjs.init({
        container: ref.current,
        height: "75vh",
        fromElement: false,
        storageManager: false,
        plugins: [newsletter],
        pluginsOpts: { [newsletter as unknown as string]: { inlineCss: true } },
        components: p.body,
        style: p.css,
      });
      editorRef.current = editor;
      window.__gjs = { editor, exportHtml, ready: true };
      setStatus("Ready");
    })().catch((e) => setStatus(`Failed to load GrapesJS: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
      editorRef.current?.destroy();
      editorRef.current = null;
      window.__gjs = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.body, p.css]);

  async function save() {
    setStatus("Saving…");
    const r = await saveGrapesAction(p.templateId, p.versionId, exportHtml());
    if (!r.ok) {
      setStatus(`Save failed: ${r.error}`);
      return;
    }
    setStatus(`Saved as version ${r.versionNo}`);
    router.push(`/templates/${p.templateId}?v=${r.versionId}`);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" type="button" onClick={save} data-testid="gjs-save">
          Save as new version (GrapesJS)
        </button>
        <span className="muted small" data-testid="gjs-status">
          {status}
        </span>
      </div>
      <div ref={ref} data-testid="gjs-container" />
    </div>
  );
}
