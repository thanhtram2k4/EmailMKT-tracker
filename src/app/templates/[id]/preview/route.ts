/**
 * Preview HTML for the sandboxed iframe. mode=edit returns the template annotated with region ids
 * (for click-to-select); mode=recipient renders merge fields for one preview recipient.
 * The response forbids scripts, forms, plugins and framing by other origins.
 */
import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/client";
import { annotatedHtml } from "../../../../lib/templates/editable";
import { renderForRecipient } from "../../../../lib/templates/merge";
import { findRecipient } from "../../../../lib/templates/recipients";
import { getVersion } from "../../../../lib/templates/service";

export const dynamic = "force-dynamic";

const EDIT_CSS = `<style data-emt-editor>[data-emt-id]{cursor:pointer}[data-emt-id]:hover{outline:2px dashed #1f5f8b;outline-offset:2px}[data-emt-selected]{outline:3px solid #d9480f!important;outline-offset:2px}</style>`;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getCurrentStaff())) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const v = await getVersion(getDb(), id, url.searchParams.get("v") ?? undefined);
  if (!v) return new NextResponse("Not found", { status: 404 });
  const mode = url.searchParams.get("mode") ?? "edit";
  let html: string;
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    "X-Frame-Options": "SAMEORIGIN",
  };
  if (mode === "recipient") {
    const r = await findRecipient(getDb(), url.searchParams.get("r") ?? "");
    if (!r) return new NextResponse("Unknown recipient", { status: 404 });
    const out = renderForRecipient(v.html, r.data);
    html = out.html;
    headers["X-Missing-Without-Fallback"] = out.missingWithoutFallback.join(",");
  } else {
    const a = annotatedHtml(v.html);
    html = /<\/head>/i.test(a) ? a.replace(/<\/head>/i, `${EDIT_CSS}</head>`) : EDIT_CSS + a;
  }
  return new NextResponse(html, { status: 200, headers });
}
