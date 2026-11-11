/** Create .env.local from .env.example with a freshly generated auth secret (never overwrites). */
import crypto from "node:crypto";
import fs from "node:fs";

if (fs.existsSync(".env.local")) {
  console.log(".env.local already exists — left unchanged.");
  process.exit(0);
}
const secret = crypto.randomBytes(32).toString("base64url");
const content = fs
  .readFileSync(".env.example", "utf8")
  .replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`);
fs.writeFileSync(".env.local", content);
console.log("Created .env.local (APP_ENV=local, SEND_MODE=disabled, dev sign-in enabled).");
