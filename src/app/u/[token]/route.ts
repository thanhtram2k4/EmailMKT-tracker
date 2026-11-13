/**
 * Public unsubscribe endpoint (DESIGN §4.3; RFC 8058):
 *  - GET shows a confirmation page and changes nothing (link scanners must not unsubscribe people);
 *  - POST unsubscribes: either one-click from the mail client (body "List-Unsubscribe=One-Click")
 *    or the button on the confirmation page.
 * The token is opaque; the page shows only a masked address. No sign-in, no cookies.
 */
import { getDb } from "../../../lib/db/client";
import { getLogger } from "../../../lib/logger";
import { lookupToken, unsubscribeByToken } from "../../../lib/campaigns/unsubscribe";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(status: number, title: string, body: string): Response {
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:40px 16px}
main{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.55;margin:0 0 12px}.muted{color:#475569;font-size:.9rem}
button{font:inherit;font-weight:600;background:#1d4ed8;color:#fff;border:0;border-radius:8px;padding:12px 18px;min-height:44px;cursor:pointer}
button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}main{background:#111a2e;border-color:#1e293b}.muted{color:#94a3b8}}</style></head>
<body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const notFound = () =>
  page(404, "Liên kết không hợp lệ", `<h1>Liên kết không hợp lệ</h1><p>Liên kết hủy đăng ký này không tồn tại hoặc đã bị thay đổi.</p><p class="muted">This unsubscribe link is not valid.</p>`);

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const found = await lookupToken(getDb(), token);
  if (!found) return notFound();
  if (found.alreadySuppressed) {
    return page(200, "Đã hủy đăng ký", `<h1 data-testid="unsub-done">Bạn đã hủy đăng ký</h1><p>Địa chỉ <strong>${esc(found.maskedEmail)}</strong> sẽ không nhận email tiếp thị từ chúng tôi nữa.</p><p class="muted">You are unsubscribed.</p>`);
  }
  return page(
    200,
    "Hủy đăng ký nhận email",
    `<h1 data-testid="unsub-confirm">Hủy đăng ký nhận email?</h1>
<p>Địa chỉ <strong>${esc(found.maskedEmail)}</strong> sẽ ngừng nhận tất cả email tiếp thị của chúng tôi.</p>
<form method="post"><button type="submit" name="confirm" value="1" data-testid="unsub-submit">Hủy đăng ký</button></form>
<p class="muted" style="margin-top:16px">Unsubscribe this address from all marketing email. Nothing changes until you press the button.</p>`,
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = (await req.text()).slice(0, 2000);
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body);
  const correlationId = req.headers.get("x-request-id") ?? undefined;
  const r = await unsubscribeByToken(getDb(), token, { method: oneClick ? "one_click" : "confirm_page", correlationId });
  if (!r) return notFound();
  getLogger().info({ request_id: correlationId, method: oneClick ? "one_click" : "confirm_page", newly: r.added }, "unsubscribe processed");
  if (oneClick) return new Response("unsubscribed", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return page(
    200,
    "Đã hủy đăng ký",
    `<h1 data-testid="unsub-done">Đã hủy đăng ký</h1><p>Địa chỉ <strong>${esc(r.maskedEmail)}</strong> sẽ không nhận email tiếp thị từ chúng tôi nữa. Thay đổi có hiệu lực ngay lập tức.</p><p class="muted">You have been unsubscribed. This takes effect immediately.</p>`,
  );
}
