import "server-only";
import { notFound } from "next/navigation";
import { requireRole, type CurrentStaff } from "./auth/session";
import { getConfig } from "./config";

/**
 * Internal test tooling (labelled fixtures, the GrapesJS comparison) is kept out of the product
 * UI. It exists only when APP_ENV is local or test, and only for admins. Elsewhere it is a 404.
 */
export function internalToolsEnabled(): boolean {
  const env = getConfig().APP_ENV;
  return env === "local" || env === "test";
}

export async function requireInternalTools(): Promise<CurrentStaff> {
  if (!internalToolsEnabled()) notFound();
  return requireRole("admin");
}
