/**
 * Convert TipTap/ProseMirror block HTML (<p>…</p>) to INLINE HTML for a template text block:
 * paragraphs are joined with <br><br>; a trailing empty paragraph is dropped.
 */
export function toInlineHtml(html: string): string {
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  if (!paras.length) return html;
  return paras.filter((p, i) => p !== "" || i < paras.length - 1).join("<br><br>");
}
