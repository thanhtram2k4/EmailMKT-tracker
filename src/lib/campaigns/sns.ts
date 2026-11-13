/**
 * Amazon SNS HTTP(S) message verification (SES events arrive via a configuration set → SNS topic).
 *
 * A message is accepted only if ALL of these hold:
 *  - it has the fields required for its Type (Notification / SubscriptionConfirmation / UnsubscribeConfirmation);
 *  - TopicArn equals the configured SES_EVENTS_TOPIC_ARN;
 *  - SigningCertURL is https://sns.<region>.amazonaws.com/<…>.pem (no other host, no redirect target);
 *  - the signature over the canonical string verifies with that certificate
 *    (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA);
 *  - the Timestamp is not older than 24 hours nor more than 5 minutes in the future (replay window;
 *    duplicates inside the window are removed by the SNS MessageId unique key).
 * Subscription confirmations are recorded only: the app never calls SubscribeURL itself.
 */
import { createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";

export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
};

export type CertResolver = (url: string) => Promise<string>;

export const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
export const MAX_AGE_MS = 24 * 3600_000;
export const MAX_FUTURE_MS = 5 * 60_000;

export function isValidCertUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && CERT_HOST.test(url.hostname) && !url.port && url.pathname.endsWith(".pem") && !url.username && !url.password;
  } catch {
    return false;
  }
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const CONFIRMATION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

/** Canonical string to sign (AWS SNS documentation, "Verifying the signatures of Amazon SNS messages"). */
export function stringToSign(m: SnsMessage): string {
  const keys = m.Type === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  let s = "";
  for (const k of keys) {
    const v = m[k];
    if (v === undefined || v === null) {
      if (k === "Subject") continue; // optional for notifications
    }
    s += `${k}\n${v ?? ""}\n`;
  }
  return s;
}

export function parseSnsBody(body: string): SnsMessage | null {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (!j || typeof j !== "object") return null;
    const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
    const req = ["Type", "MessageId", "TopicArn", "Message", "Timestamp", "SignatureVersion", "Signature", "SigningCertURL"];
    if (req.some((k) => !str(k))) return null;
    const m: SnsMessage = {
      Type: str("Type")!,
      MessageId: str("MessageId")!,
      TopicArn: str("TopicArn")!,
      Message: str("Message")!,
      Timestamp: str("Timestamp")!,
      SignatureVersion: str("SignatureVersion")!,
      Signature: str("Signature")!,
      SigningCertURL: str("SigningCertURL")!,
      Subject: str("Subject"),
      SubscribeURL: str("SubscribeURL"),
      Token: str("Token"),
      UnsubscribeURL: str("UnsubscribeURL"),
    };
    if (m.Type !== "Notification" && (!m.SubscribeURL || !m.Token)) return null;
    return m;
  } catch {
    return null;
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function keyFromPem(pem: string, now: Date): KeyObject {
  if (pem.includes("BEGIN CERTIFICATE")) {
    const x = new X509Certificate(pem);
    if (new Date(x.validFrom) > now || new Date(x.validTo) < now) throw new Error("signing certificate is not currently valid");
    return x.publicKey;
  }
  return createPublicKey(pem);
}

export async function verifySnsMessage(m: SnsMessage, o: { expectedTopicArn: string | undefined; resolveCert: CertResolver; now?: Date }): Promise<VerifyResult> {
  const now = o.now ?? new Date();
  if (!o.expectedTopicArn) return { ok: false, reason: "no SNS topic is configured (SES_EVENTS_TOPIC_ARN)" };
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(m.Type)) return { ok: false, reason: "unsupported message type" };
  if (m.TopicArn !== o.expectedTopicArn) return { ok: false, reason: "unexpected topic" };
  if (!isValidCertUrl(m.SigningCertURL)) return { ok: false, reason: "signing certificate URL is not an SNS host" };
  const algo = m.SignatureVersion === "1" ? "sha1" : m.SignatureVersion === "2" ? "sha256" : null;
  if (!algo) return { ok: false, reason: "unsupported signature version" };
  const t = Date.parse(m.Timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: "bad timestamp" };
  if (now.getTime() - t > MAX_AGE_MS || t - now.getTime() > MAX_FUTURE_MS) return { ok: false, reason: "timestamp outside the accepted window" };
  let key: KeyObject;
  try {
    key = keyFromPem(await o.resolveCert(m.SigningCertURL), now);
  } catch (e) {
    return { ok: false, reason: `certificate unavailable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  let good = false;
  try {
    good = verify(algo, Buffer.from(stringToSign(m), "utf8"), key, Buffer.from(m.Signature, "base64"));
  } catch {
    good = false;
  }
  return good ? { ok: true } : { ok: false, reason: "signature does not verify" };
}

/** Production resolver: fetch the PEM from the validated SNS host (cached in memory). */
export function httpsCertResolver(timeoutMs = 5000): CertResolver {
  const cache = new Map<string, string>();
  return async (url) => {
    if (!isValidCertUrl(url)) throw new Error("refusing to fetch a certificate from a non-SNS host");
    const hit = cache.get(url);
    if (hit) return hit;
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`certificate fetch failed: HTTP ${res.status}`);
    const pem = await res.text();
    if (!pem.includes("BEGIN CERTIFICATE")) throw new Error("not a PEM certificate");
    cache.set(url, pem);
    return pem;
  };
}
