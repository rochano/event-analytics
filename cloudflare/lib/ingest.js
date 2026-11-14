// Ingestion rules, ported from internal/collector (event.go, server.go) so both
// editions accept the same payloads and store the same derived fields.

export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_EVENT_BYTES = 32 << 10;
export const MAX_PROPERTIES = 200;
export const MAX_EVENT_NAME = 255;
export const MAX_BODY_BYTES = 2 << 20;
const MAX_PAST_MS = 7 * 24 * 3600 * 1000;
const MAX_FUTURE_MS = 3600 * 1000;

const propKeyRe = /^[$a-zA-Z0-9_.\-]{1,128}$/;
const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// parseBatch accepts a JSON array of events, one event object, or an envelope
// {"api_key","sent_at","batch":[...]}. Returns {events, apiKey, sentAt}.
export function parseBatch(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("empty body");
  let v;
  try {
    v = JSON.parse(t);
  } catch (e) {
    throw new Error("bad json: " + e.message);
  }
  if (Array.isArray(v)) return { events: v, apiKey: "", sentAt: "" };
  if (!v || typeof v !== "object") throw new Error("bad json: expected an object or array");
  if (Array.isArray(v.batch)) return { events: v.batch, apiKey: str(v.api_key), sentAt: str(v.sent_at) };
  return { events: [v], apiKey: str(v.api_key), sentAt: str(v.sent_at) };
}

function str(v) {
  return typeof v === "string" ? v : "";
}

function parseTime(s) {
  // RFC 3339 only, like the Go collector.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s)) return NaN;
  return Date.parse(s);
}

// normalize validates one event and returns the row to store, or throws.
// meta: {receivedAt (ms), sentAt (ms or 0), userAgent, country}
export function normalize(input, appId, meta, newUUID = uuidv7) {
  const ev = input && typeof input === "object" ? input : {};
  const name = str(ev.event);
  if (!name || name.length > MAX_EVENT_NAME) throw new Error("event name missing or longer than 255");
  const distinctId = str(ev.distinct_id);
  if (!distinctId || distinctId.length > 200) throw new Error("distinct_id missing or longer than 200");
  let props = ev.properties;
  if (props == null) props = {};
  if (typeof props !== "object" || Array.isArray(props)) throw new Error("properties must be an object");
  const keys = Object.keys(props);
  if (keys.length > MAX_PROPERTIES) throw new Error(`more than ${MAX_PROPERTIES} properties`);
  for (const k of keys) if (!propKeyRe.test(k)) throw new Error(`invalid property key "${k}"`);

  let ts = meta.receivedAt;
  if (ev.timestamp) {
    let t = parseTime(str(ev.timestamp));
    if (!Number.isFinite(t)) throw new Error("bad timestamp");
    if (meta.sentAt) t += meta.receivedAt - meta.sentAt; // correct device clock skew
    ts = t;
  }
  if (meta.receivedAt - ts > MAX_PAST_MS) throw new Error("timestamp older than 7 days");
  if (ts - meta.receivedAt > MAX_FUTURE_MS) throw new Error("timestamp more than 1 hour in the future");

  const propsJSON = JSON.stringify(props);
  if (new TextEncoder().encode(propsJSON).length > MAX_EVENT_BYTES) throw new Error("event larger than 32 KB");

  const p = (k) => (typeof props[k] === "string" ? props[k] : "");
  const row = {
    ts: Math.round(ts),
    event: name,
    uuid: uuidRe.test(str(ev.event_uuid)) ? ev.event_uuid : newUUID(),
    distinct_id: distinctId,
    session_id: str(ev.session_id).slice(0, 200),
    url: "",
    pathname: "",
    referrer_domain: "",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    country_code: "",
    device_type: "",
    os: "",
    browser: "",
    props: propsJSON,
  };
  const c = String(meta.country || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1") row.country_code = c;

  const cur = p("$current_url");
  if (cur) {
    row.url = cur;
    try {
      const u = new URL(cur);
      row.pathname = u.pathname;
      row.utm_source = u.searchParams.get("utm_source") || "";
      row.utm_medium = u.searchParams.get("utm_medium") || "";
      row.utm_campaign = u.searchParams.get("utm_campaign") || "";
    } catch {
      /* keep the raw url only */
    }
  }
  if (p("$pathname")) row.pathname = p("$pathname");
  if (!row.utm_source) row.utm_source = p("utm_source");
  row.referrer_domain = referrerDomain(p("$referrer"), row.url);

  const ua = p("$user_agent") || meta.userAgent || "";
  [row.device_type, row.os, row.browser] = parseUA(ua);
  if (p("$device_type")) row.device_type = p("$device_type");
  if (p("$os")) row.os = p("$os");
  return row;
}

export function referrerDomain(ref, current) {
  if (!ref) return "$direct";
  let host;
  try {
    host = new URL(ref).hostname;
  } catch {
    return "$direct";
  }
  if (!host) return "$direct";
  host = host.toLowerCase().replace(/^www\./, "");
  try {
    if (new URL(current).hostname.toLowerCase().replace(/^www\./, "") === host) return "$direct"; // internal navigation
  } catch {
    /* no current url */
  }
  return host;
}

// parseUA is the same small classifier as the Go collector.
export function parseUA(ua) {
  const l = String(ua || "").toLowerCase();
  if (!l) return ["", "", ""];
  let device, os = "", browser = "";
  if (l.includes("ipad") || l.includes("tablet")) device = "Tablet";
  else if (l.includes("mobi") || l.includes("iphone") || l.includes("android")) device = "Mobile";
  else if (l.includes("bot") || l.includes("spider") || l.includes("crawl")) device = "Bot";
  else if (l.includes("mozilla")) device = "Desktop";
  else device = "Other";
  if (l.includes("iphone") || l.includes("ipad") || l.includes("ios")) os = "iOS";
  else if (l.includes("android")) os = "Android";
  else if (l.includes("windows")) os = "Windows";
  else if (l.includes("mac os") || l.includes("macintosh")) os = "macOS";
  else if (l.includes("linux")) os = "Linux";
  if (l.includes("edg/")) browser = "Edge";
  else if (l.includes("line/")) browser = "LINE";
  else if (l.includes("fban") || l.includes("fbav")) browser = "Facebook";
  else if (l.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (l.includes("chrome/") || l.includes("crios")) browser = "Chrome";
  else if (l.includes("firefox/") || l.includes("fxios")) browser = "Firefox";
  else if (l.includes("safari/")) browser = "Safari";
  else if (l.includes("unity") || l.includes("unreal") || l.includes("godot")) browser = "Game engine";
  return [device, os, browser];
}

// uuidv7 returns a time-ordered UUID (RFC 9562).
export function uuidv7() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// readBody reads the request body (gzip allowed) with a size cap.
export async function readBody(request) {
  let stream = request.body;
  if (!stream) return "";
  if ((request.headers.get("Content-Encoding") || "").toLowerCase() === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      const err = new Error("body larger than 2 MB");
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
