/** Download a template version as HTML (canonical, no editor annotations) or plain text. */
import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/client";
import { stripAnnotations } from "../../../../lib/templates/editable";
import { getTemplate, getVersion } from "../../../../lib/templates/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getCurrentStaff())) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const t = await getTemplate(getDb(), id);
  const v = await getVersion(getDb(), id, url.searchParams.get("v") ?? undefined);
  if (!t || !v) return new NextResponse("Not found", { status: 404 });
  const base = (t.template.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "template").toLowerCase();
  const txt = url.searchParams.get("format") === "txt";
  return new NextResponse(txt ? v.plainText : stripAnnotations(v.html), {
    headers: {
      "Content-Type": `${txt ? "text/plain" : "text/html"}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${base}-v${v.versionNo}.${txt ? "txt" : "html"}"`,
      "Cache-Control": "no-store",
    },
  });
}
