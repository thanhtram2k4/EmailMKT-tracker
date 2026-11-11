/**
 * Sending guard — the single decision point for whether any email may leave the system.
 *
 * Rules (CLAUDE.md "Sending rules", docs/DESIGN.md §8 safety guard):
 *  1. Customer campaigns are only ever sent from APP_ENV=production with SEND_MODE=live,
 *     and only after an admin has enabled live campaigns (and, from M5, per-campaign approval).
 *     They are never sent from local, test or staging environments.
 *  2. Outside production, real sends are limited to integration tests and test sends:
 *       - SEND_MODE=simulator → every recipient must be an SES mailbox-simulator address;
 *       - SEND_MODE=allowlist → every recipient must be on TEST_RECIPIENT_ALLOWLIST;
 *     and both require SEND_AUTHORIZATION_REF (explicit approval on record).
 *  3. SEND_MODE=mock never touches the network; it records messages locally.
 *  4. SEND_MODE=disabled refuses everything (default).
 *
 * In M1 no real transport exists, so any decision that selects a real transport is
 * refused by the transport factory (see ./transport.ts) even if the guard would allow it.
 */
import type { AppEnv, SendMode } from "../config";
import { normalizeEmail } from "../auth/access";

export type SendPurpose = "customer_campaign" | "integration_test" | "test_send";

export type GuardInput = {
  appEnv: AppEnv;
  sendMode: SendMode;
  purpose: SendPurpose;
  recipients: string[];
  testRecipientAllowlist: string[];
  authorizationRef?: string;
  /** Admin toggle stored in app_settings (production only). */
  liveCampaignsEnabled: boolean;
};

export type GuardDecision =
  | { allowed: true; transport: "mock" | "real" }
  | { allowed: false; reason: string };

export const SES_SIMULATOR_DOMAIN = "simulator.amazonses.com";

export function isSimulatorAddress(email: string): boolean {
  return normalizeEmail(email).endsWith(`@${SES_SIMULATOR_DOMAIN}`);
}

export function decideSend(i: GuardInput): GuardDecision {
  const deny = (reason: string): GuardDecision => ({ allowed: false, reason });
  if (i.recipients.length === 0) return deny("no recipients");
  const recipients = i.recipients.map(normalizeEmail);
  const isProd = i.appEnv === "production";

  if (i.sendMode === "disabled") return deny("sending is disabled (SEND_MODE=disabled)");

  if (i.sendMode === "mock") {
    if (isProd) return deny("SEND_MODE=mock is not permitted in production");
    // Mock never leaves the process, so campaign flows can be exercised locally.
    return { allowed: true, transport: "mock" };
  }

  if (i.purpose === "customer_campaign") {
    if (!isProd) return deny(`customer campaigns cannot be sent from APP_ENV=${i.appEnv}`);
    if (i.sendMode !== "live") return deny(`customer campaigns require SEND_MODE=live (current: ${i.sendMode})`);
    if (!i.liveCampaignsEnabled) return deny("live campaigns have not been enabled by an administrator");
    return { allowed: true, transport: "real" };
  }

  // integration_test / test_send
  if (i.sendMode === "live") {
    if (!isProd) return deny("SEND_MODE=live is only valid in production");
    // Production test sends still go only to allowlisted staff/test inboxes.
    const outside = recipients.filter((r) => !i.testRecipientAllowlist.includes(r) && !isSimulatorAddress(r));
    if (outside.length) return deny(`${outside.length} recipient(s) not on TEST_RECIPIENT_ALLOWLIST`);
    return { allowed: true, transport: "real" };
  }

  if (!i.authorizationRef) return deny(`SEND_MODE=${i.sendMode} requires SEND_AUTHORIZATION_REF`);

  if (i.sendMode === "simulator") {
    const outside = recipients.filter((r) => !isSimulatorAddress(r));
    if (outside.length) return deny(`${outside.length} recipient(s) are not SES simulator addresses`);
    return { allowed: true, transport: "real" };
  }

  // allowlist
  const outside = recipients.filter((r) => !i.testRecipientAllowlist.includes(r));
  if (outside.length) return deny(`${outside.length} recipient(s) not on TEST_RECIPIENT_ALLOWLIST`);
  return { allowed: true, transport: "real" };
}
