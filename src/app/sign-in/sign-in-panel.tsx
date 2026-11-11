"use client";
import { useState } from "react";
import { authClient } from "../../lib/auth/client";

export function SignInPanel(props: { googleEnabled: boolean; devLogin: boolean; appEnv: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function google() {
    setBusy(true);
    setError(null);
    const r = await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/access-denied" });
    if (r.error) {
      setError(r.error.message ?? "Sign-in failed");
      setBusy(false);
    }
  }

  async function devSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dev/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      setError(data.error ?? "Dev sign-in failed");
      setBusy(false);
      return;
    }
    window.location.assign(data.url);
  }

  return (
    <div>
      <button className="btn primary" onClick={google} disabled={!props.googleEnabled || busy} data-testid="google-sign-in">
        Sign in with Google
      </button>
      {!props.googleEnabled && (
        <p className="muted" style={{ fontSize: 13 }}>
          Google sign-in is not configured in this environment (no OAuth client).
        </p>
      )}

      {props.devLogin && (
        <form onSubmit={devSignIn} style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
            Dev sign-in <span className="pill">APP_ENV={props.appEnv} only</span>
          </p>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            For local testing without Google. The same domain and access-list checks apply. Nothing is emailed.
          </p>
          <div className="row">
            <label htmlFor="dev-email" className="muted" style={{ fontSize: 13 }}>
              Email
            </label>
            <input
              id="dev-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              data-testid="dev-email"
            />
            <button className="btn" type="submit" disabled={busy} data-testid="dev-sign-in">
              Continue
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
