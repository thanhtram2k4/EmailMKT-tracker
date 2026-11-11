/**
 * Create .env.local from .env.example with freshly generated local secrets, or — if .env.local
 * already exists — append only the keys that are missing (never changes existing values).
 * Local defaults: APP_ENV=local, SEND_MODE=disabled, NOTION_MODE=mock (synthetic data, loopback only).
 */
import crypto from "node:crypto";
import fs from "node:fs";

const gen = () => crypto.randomBytes(32).toString("base64url");
const LOCAL_OVERRIDES: Record<string, () => string> = {
  BETTER_AUTH_SECRET: gen,
  APP_ENCRYPTION_KEY: gen,
  NOTION_MODE: () => "mock",
};

const example = fs.readFileSync(".env.example", "utf8");
const exampleKeys = [...example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => ({ key: m[1], value: m[2] }));

if (!fs.existsSync(".env.local")) {
  let content = example;
  for (const [k, f] of Object.entries(LOCAL_OVERRIDES)) content = content.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${f()}`);
  fs.writeFileSync(".env.local", content);
  console.log("Created .env.local (APP_ENV=local, SEND_MODE=disabled, NOTION_MODE=mock, dev sign-in enabled).");
  process.exit(0);
}

const current = fs.readFileSync(".env.local", "utf8");
const have = new Set([...current.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
const missing = exampleKeys.filter((k) => !have.has(k.key));
if (!missing.length) {
  console.log(".env.local already has every key — left unchanged.");
  process.exit(0);
}
const lines = missing.map((k) => `${k.key}=${LOCAL_OVERRIDES[k.key]?.() ?? k.value}`);
fs.appendFileSync(".env.local", `\n# Added by setup:local on ${new Date().toISOString()}\n${lines.join("\n")}\n`);
console.log(`Added ${missing.length} missing key(s) to .env.local: ${missing.map((k) => k.key).join(", ")}`);
