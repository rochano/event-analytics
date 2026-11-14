// Copies the shared dashboard (../web) and JS SDK (../sdk/js) into public/,
// which Cloudflare Pages serves as static files next to functions/.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "public");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "sdk"), { recursive: true });
cpSync(join(here, "..", "web"), out, { recursive: true });
cpSync(join(here, "..", "sdk", "js", "analytics.js"), join(out, "sdk", "analytics.js"));
console.log("built", out);
