/**
 * LOCAL/TEST ONLY dev sign-in. Returns a one-time magic-link URL for the given email instead
 * of emailing it. The link still goes through the same domain + allowlist gate as Google.
 * Responds 404 unless APP_ENV is local|test AND DEV_LOGIN_ENABLED=true (config validation also
 * refuses DEV_LOGIN_ENABLED in staging/production).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, takeDevMagicLink } from "../../../../lib/auth/auth";
import { getConfig } from "../../../../lib/config";

export const dynamic = "force-dynamic";

const body = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  const cfg = getConfig();
  if (!(cfg.DEV_LOGIN_ENABLED && (cfg.APP_ENV === "local" || cfg.APP_ENV === "test"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "a valid email is required" }, { status: 400 });

  const email = parsed.data.email.trim().toLowerCase();
  await getAuth().api.signInMagicLink({
    body: { email, callbackURL: "/", errorCallbackURL: "/access-denied" },
    headers: req.headers,
  });
  const url = takeDevMagicLink(email);
  if (!url) return NextResponse.json({ error: "could not create sign-in link" }, { status: 500 });
  return NextResponse.json({ url, note: "Local dev sign-in link (not emailed). Valid for 5 minutes, single use." });
}
