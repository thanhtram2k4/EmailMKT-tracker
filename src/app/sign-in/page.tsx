import { redirect } from "next/navigation";
import { getCurrentStaff } from "../../lib/auth/session";
import { getConfig } from "../../lib/config";
import { SignInPanel } from "./sign-in-panel";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (await getCurrentStaff()) redirect("/");
  const cfg = getConfig();
  const devLogin = cfg.DEV_LOGIN_ENABLED && (cfg.APP_ENV === "local" || cfg.APP_ENV === "test");
  return (
    <main className="center">
      <div className="card auth-card">
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Email MKT Tracker</h1>
        <p className="muted">
          Sign in with your company Google account. Only staff on the access list can use this app.
        </p>
        <SignInPanel googleEnabled={cfg.googleEnabled} devLogin={devLogin} appEnv={cfg.APP_ENV} />
      </div>
    </main>
  );
}
