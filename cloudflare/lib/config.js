// Project settings for the Cloudflare edition. PROJECTS uses the same format as
// the Go services: "app_id|write_key|read_key|origins(comma)|rate|burst|retention_days|name;..."
export function parseProjects(raw) {
  const out = [];
  // Forgive what pasting into a dashboard field tends to add: quotes,
  // backticks, spaces and line breaks. Projects may also be one per line.
  const text = String(raw || "").replace(/[`"']/g, "");
  for (const part of text.split(/[;\r\n]+/)) {
    const raw = part.trim().split("|");
    const f = raw.map((s) => s.replace(/\s+/g, ""));
    if (!f[0]) continue;
    const appId = Number(f[0]);
    if (!Number.isInteger(appId) || appId <= 0 || !f[1]) continue; // skipped; /healthz shows the count
    out.push({
      appId,
      writeKey: f[1],
      readKey: f[2] || "",
      origins: f[3] && f[3] !== "*" ? f[3].split(",").map((s) => s.trim()).filter(Boolean) : [],
      retentionDays: Number(f[6]) > 0 ? Number(f[6]) : 395,
      name: (raw[7] || "").trim(), // spaces kept
    });
  }
  return out;
}

export function projectsFrom(env) {
  return parseProjects(env.PROJECTS || "");
}

// Minutes east of UTC used for daily buckets (Thailand: 420). Fixed offset;
// zones with daylight saving are off by an hour in summer.
export function tzOffset(env) {
  const n = Number(env.TZ_OFFSET_MINUTES);
  return Number.isFinite(n) && n >= -720 && n <= 840 ? n : 420;
}

export function tzLabel(min) {
  const s = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `UTC${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// Same rule as the Go collector: exact match, "*", or "https://*.example.com".
export function originAllowed(list, origin) {
  if (!list.length) return true;
  const low = origin.toLowerCase();
  for (const o of list) {
    if (o === "*" || o.toLowerCase() === low) return true;
    const i = o.indexOf("://*.");
    if (i > 0) {
      const pre = o.slice(0, i + 3).toLowerCase();
      const host = o.slice(i + 5).toLowerCase();
      if (low.startsWith(pre) && low.endsWith("." + host)) return true;
    }
  }
  return false;
}

// Constant-time string comparison for keys.
export function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
