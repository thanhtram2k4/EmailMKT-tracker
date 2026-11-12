import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/client";
import { parseHtml } from "../../../../lib/templates/html-doc";
import { getTemplate, getVersion } from "../../../../lib/templates/service";
import { AppHeader } from "../../../app-header";
import { GrapesLab } from "./grapes-lab";

export const dynamic = "force-dynamic";

/** Candidate (b): GrapesJS + grapesjs-preset-newsletter, for comparison in the M3 trial. */
export default async function GrapesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const t = await getTemplate(db, id);
  const v = await getVersion(db, id, sp.v);
  if (!t || !v) notFound();
  // GrapesJS edits the <body> and its CSS; the original <head> is kept and re-attached on export.
  const $ = parseHtml(v.html);
  const css = $("head style").map((_, s) => $(s).html() ?? "").get().join("\n");
  const head = $("head").html() ?? "";
  const doctypeMatch = /^\s*<!doctype[^>]*>/i.exec(v.html);
  const htmlAttrs = Object.entries($("html").attr() ?? {}).map(([k, val]) => `${k}="${String(val).replace(/"/g, "&quot;")}"`).join(" ");
  const body = $("body").length ? ($("body").html() ?? "") : v.html;
  const bodyAttrs = Object.entries($("body").attr() ?? {}).map(([k, val]) => `${k}="${String(val).replace(/"/g, "&quot;")}"`).join(" ");

  return (
    <main className="shell wide">
      <AppHeader staff={staff} />
      <p>
        <Link href={`/templates/${id}?v=${v.id}`}>← Back to the structure-preserving editor</Link>
      </p>
      <h1 className="page-title">GrapesJS trial — {t.template.name} (v{v.versionNo})</h1>
      <div className="banner warn small">
        Trial of candidate (b). Export = the original &lt;head&gt; + GrapesJS body with inlined CSS. Results are measured in the M3 report; browser preview only.
      </div>
      <GrapesLab templateId={id} versionId={v.id} body={body} css={css} head={head} doctype={doctypeMatch?.[0] ?? "<!doctype html>"} htmlAttrs={htmlAttrs} bodyAttrs={bodyAttrs} />
    </main>
  );
}
