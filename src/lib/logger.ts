/**
 * Structured JSON logging (pino). Every log line from a request or job carries a
 * correlation id so QA reports can extract the exact lines for one scenario:
 *   request_id, job_id, task, and later campaign_id / snapshot_id / schedule_revision / message_id.
 *
 * Secrets are redacted by key path; free-text redaction for evidence lives in ./redact.ts.
 */
import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "secret",
  "authorization",
  "cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "req.headers.authorization",
  "req.headers.cookie",
];

let root: Logger | undefined;

export function getLogger(): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL ?? "info",
      base: {
        service: process.env.SERVICE_NAME ?? "web",
        env: process.env.APP_ENV ?? "unknown",
        build: process.env.BUILD_ID ?? "dev",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      formatters: { level: (label) => ({ level: label }) },
    });
  }
  return root;
}

export type Correlation = {
  request_id?: string;
  job_id?: string;
  task?: string;
  campaign_id?: string;
  snapshot_id?: string;
  schedule_revision?: number;
  message_id?: string;
};

export function withCorrelation(c: Correlation): Logger {
  return getLogger().child(c);
}
