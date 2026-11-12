/**
 * Next.js 16 proxy (formerly middleware):
 *  - assigns every request a correlation id (x-request-id) used in logs and audit rows;
 *  - optimistic auth redirect for app pages (the real check, including the allowlist,
 *    happens server-side in requireStaff()).
 */
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// /fixtures: SYNTHETIC demo images used by the M3 template fixtures (public, no data).
const PUBLIC_PREFIXES = ["/sign-in", "/access-denied", "/healthz", "/api/auth", "/api/dev", "/_next", "/favicon.ico", "/fixtures"];

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!isPublic && !getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    const res = NextResponse.redirect(url);
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
