// Google Search Console and GA4 import. One Google service account (the
// GOOGLE_SERVICE_ACCOUNT secret, its JSON key) reads every linked property;
// the property owner adds the service account's email as a user. Data is
// pulled into D1 and served from there, so the dashboard never waits on
// Google and stays inside the free plans:
//   - Pages Functions have no cron, so a sync runs when someone opens the SEO
//     tab (at most every SYNC_EVERY_MS) or presses "sync now".
//   - Each sync is small (one backfill chunk), because the free plan allows
//     10 ms of CPU per request. The dashboard calls sync again while
//     backfilling is not done.
//   - Rows go in with one INSERT ... SELECT FROM json_each(?) per table, so a
//     sync stays far below D1's per-request query limit.
import { DAY, localDay, localMidnight } from "./time.js";

export const GOOGLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS google_links (
    app_id       INTEGER PRIMARY KEY,
    gsc_site     TEXT    NOT NULL DEFAULT '', -- "sc-domain:example.com" or "https://example.com/"
    ga4_property TEXT    NOT NULL DEFAULT '', -- digits only
    synced_at    INTEGER NOT NULL DEFAULT 0,  -- last finished sync (ms)
    lock_until   INTEGER NOT NULL DEFAULT 0,  -- a sync is running until then
    gsc_from     TEXT    NOT NULL DEFAULT '', -- oldest day of page/query rows fetched so far
    gsc_error    TEXT    NOT NULL DEFAULT '',
    ga4_error    TEXT    NOT NULL DEFAULT ''
  )`,
  // Clicks and impressions per day for the whole site, including the
  // anonymized queries Google leaves out of the per-query rows.
  `CREATE TABLE IF NOT EXISTS gsc_totals (
    app_id INTEGER NOT NULL, day TEXT NOT NULL,
    clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, pos_sum REAL NOT NULL,
    PRIMARY KEY (app_id, day)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS gsc_rows (
    app_id INTEGER NOT NULL, day TEXT NOT NULL, query TEXT NOT NULL, page TEXT NOT NULL,
    clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, pos_sum REAL NOT NULL,
    PRIMARY KEY (app_id, day, query, page)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ga4_rows (
    app_id INTEGER NOT NULL, day TEXT NOT NULL, channel TEXT NOT NULL,
    sessions INTEGER NOT NULL, users INTEGER NOT NULL, engaged INTEGER NOT NULL, key_events REAL NOT NULL,
    PRIMARY KEY (app_id, day, channel)
  ) WITHOUT ROWID`,
];

export const SYNC_EVERY_MS = 6 * 3600_000; // automatic sync when the SEO tab is opened
export const MANUAL_EVERY_MS = 10 * 60_000; // "sync now" from the dashboard
const LOCK_MS = 2 * 60_000;
const TOTALS_DAYS = 180; // enough for "90 days vs the 90 before"
const DETAIL_DAYS = 90; // page x query rows
const CHUNK_DAYS = 10; // detail backfill per sync
const RECENT_DAYS = 5; // re-fetched every sync: Google revises the last days
const ROW_LIMIT = 5000;

const ready = new WeakSet();
export async function ensureGoogle(db) {
  if (ready.has(db)) return;
  await db.batch(GOOGLE_SCHEMA.map((s) => db.prepare(s)));
  ready.add(db);
}

export class GoogleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Service account and access token ----------------------------------------

// serviceAccount reads the JSON key, also accepted base64-encoded (easier to
// paste into some forms). Returns null when it is not set.
export function serviceAccount(env) {
  let raw = String(env.GOOGLE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("{")) {
    try {
      raw = atob(raw.replace(/\s+/g, ""));
    } catch {
      return { error: "GOOGLE_SERVICE_ACCOUNT ไม่ใช่ JSON key ของ service account" };
    }
  }
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return { error: "GOOGLE_SERVICE_ACCOUNT ไม่มี client_email หรือ private_key (ใช้ไฟล์ JSON key ทั้งไฟล์)" };
    return { email: j.client_email, privateKey: j.private_key, tokenUri: j.token_uri || "https://oauth2.googleapis.com/token" };
  } catch {
    return { error: "GOOGLE_SERVICE_ACCOUNT อ่านเป็น JSON ไม่ได้ (คัดลอกไฟล์ JSON key ทั้งไฟล์มาวาง)" };
  }
}

const SCOPES = "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

function pemToDer(pem) {
  const body = String(pem).replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let tokenCache = null; // { email, token, exp }

export function forgetToken() {
  tokenCache = null;
}

export async function accessToken(sa, now = Date.now()) {
  if (tokenCache && tokenCache.email === sa.email && tokenCache.exp > now + 60_000) return tokenCache.token;
  const iat = Math.floor(now / 1000);
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: sa.email, scope: SCOPES, aud: sa.tokenUri, iat, exp: iat + 3600 }));
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GoogleError(500, "private_key ใน GOOGLE_SERVICE_ACCOUNT ใช้ไม่ได้");
  }
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  const res = await fetch(sa.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(sig)}` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new GoogleError(502, `Google ไม่ให้ token: ${j.error_description || j.error || res.status}`);
  tokenCache = { email: sa.email, token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  return j.access_token;
}

async function googleJSON(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(res.status, explain(res.status, j.error?.message || ""));
  return j;
}

// explain turns Google's errors into what the owner should do.
function explain(status, msg) {
  if (status === 403 && /not enabled|has not been used|disabled/i.test(msg)) return `ยังไม่ได้เปิด API ใน Google Cloud: ${msg}`;
  if (status === 403 || status === 401) return `service account ยังไม่มีสิทธิ์ (เพิ่มอีเมล service account เป็นผู้ใช้ของ property นี้): ${msg}`;
  if (status === 404) return `ไม่พบ property นี้ เช็กว่าพิมพ์ถูก: ${msg}`;
  if (status === 429) return "Google จำกัดจำนวนครั้ง รอสักครู่แล้วลองใหม่";
  return `Google ตอบ ${status}: ${msg}`;
}

// ---- Links -----------------------------------------------------------------

// cleanSite accepts a Search Console property as shown in Search Console:
// "sc-domain:example.com" (Domain property) or a URL prefix.
export function cleanSite(input) {
  let s = String(input || "").trim();
  if (!s) return "";
  if (/^sc-domain:/i.test(s)) {
    const host = s.slice(10).trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new GoogleError(400, "Domain property ต้องเป็นแบบ sc-domain:example.com");
    return "sc-domain:" + host;
  }
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new GoogleError(400, "ที่อยู่เว็บใน Search Console ไม่ถูกรูปแบบ (เช่น https://mygame.pages.dev/)");
  }
  if (!u.hostname.includes(".") || !/^https?:$/.test(u.protocol)) throw new GoogleError(400, "ที่อยู่เว็บใน Search Console ไม่ถูกรูปแบบ (เช่น https://mygame.pages.dev/)");
  if (u.search || u.hash) throw new GoogleError(400, "ใส่แค่ที่อยู่เว็บ ไม่ต้องมี ? หรือ #");
  return u.origin + (u.pathname.endsWith("/") ? u.pathname : u.pathname + "/");
}

export function cleanProperty(input) {
  const s = String(input || "").trim().replace(/^properties\//i, "");
  if (!s) return "";
  if (!/^\d{5,15}$/.test(s)) throw new GoogleError(400, "GA4 Property ID เป็นตัวเลขล้วน (ดูที่ Admin > Property details) ไม่ใช่ G-XXXX");
  return s;
}

export async function getLink(db, appId) {
  await ensureGoogle(db);
  return db.prepare("SELECT * FROM google_links WHERE app_id = ?").bind(appId).first();
}

export async function allLinks(db) {
  await ensureGoogle(db);
  return (await db.prepare("SELECT * FROM google_links ORDER BY app_id").all()).results || [];
}

// setLink saves the properties for a project. Changing a property clears
// the old data, so numbers from two sites never mix.
export async function setLink(db, appId, body) {
  await ensureGoogle(db);
  const cur = await getLink(db, appId);
  const site = body.gsc_site !== undefined ? cleanSite(body.gsc_site) : cur?.gsc_site || "";
  const prop = body.ga4_property !== undefined ? cleanProperty(body.ga4_property) : cur?.ga4_property || "";
  const stmts = [];
  if (!cur || cur.gsc_site !== site) {
    stmts.push(db.prepare("DELETE FROM gsc_totals WHERE app_id = ?").bind(appId), db.prepare("DELETE FROM gsc_rows WHERE app_id = ?").bind(appId));
  }
  if (!cur || cur.ga4_property !== prop) stmts.push(db.prepare("DELETE FROM ga4_rows WHERE app_id = ?").bind(appId));
  stmts.push(db.prepare(
    `INSERT INTO google_links (app_id, gsc_site, ga4_property, synced_at, gsc_from, gsc_error, ga4_error)
     VALUES (?, ?, ?, 0, '', '', '')
     ON CONFLICT (app_id) DO UPDATE SET gsc_site = excluded.gsc_site, ga4_property = excluded.ga4_property,
       synced_at = 0, gsc_from = CASE WHEN google_links.gsc_site = excluded.gsc_site THEN google_links.gsc_from ELSE '' END,
       gsc_error = '', ga4_error = ''`,
  ).bind(appId, site, prop));
  await db.batch(stmts);
  return getLink(db, appId);
}

// ---- Sync ------------------------------------------------------------------

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => dayStr(Date.parse(day + "T00:00:00Z") + n * DAY);
const gaDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// Google reports Search Console days in Pacific time; "today" there is at
// most today in UTC, so UTC dates are a safe upper bound.
function backfillDone(link, today) {
  return !!link.gsc_from && link.gsc_from <= addDays(today, -DETAIL_DAYS + 1);
}

export function needsBackfill(link, now = Date.now()) {
  return !!link?.gsc_site && !backfillDone(link, dayStr(now));
}

// due says whether an automatic sync should start now.
export function due(link, now = Date.now(), every = SYNC_EVERY_MS) {
  if (!link || (!link.gsc_site && !link.ga4_property)) return false;
  if (link.lock_until > now) return false;
  return needsBackfill(link, now) || now - link.synced_at >= every;
}

async function replaceRange(db, table, cols, appId, from, to, rows) {
  const stmts = [db.prepare(`DELETE FROM ${table} WHERE app_id = ? AND day BETWEEN ? AND ?`).bind(appId, from, to)];
  if (rows.length) {
    const pick = cols.map((c, i) => `json_extract(value, '$[${i}]')`).join(", ");
    stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (app_id, ${cols.join(", ")}) SELECT ?, ${pick} FROM json_each(?)`)
      .bind(appId, JSON.stringify(rows)));
  }
  await db.batch(stmts);
}

async function gscQuery(token, site, body) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  return (await googleJSON(url, token, { dataState: "all", rowLimit: ROW_LIMIT, ...body })).rows || [];
}

async function syncGSC(db, token, link, today) {
  const site = link.gsc_site;
  const recentFrom = addDays(today, -RECENT_DAYS + 1);
  // 1. Daily totals: the full window on the first sync, then the recent days.
  const totalsFrom = link.synced_at ? recentFrom : addDays(today, -TOTALS_DAYS + 1);
  const totals = await gscQuery(token, site, { startDate: totalsFrom, endDate: today, dimensions: ["date"] });
  await replaceRange(db, "gsc_totals", ["day", "clicks", "impressions", "pos_sum"], link.app_id, totalsFrom, today,
    totals.map((r) => [r.keys[0], r.clicks, r.impressions, r.position * r.impressions]));

  // 2. Page x query rows: the recent days, plus one older chunk until
  // DETAIL_DAYS are covered.
  const ranges = [[recentFrom, today]];
  let from = link.gsc_from && link.gsc_from <= recentFrom ? link.gsc_from : recentFrom;
  const oldest = addDays(today, -DETAIL_DAYS + 1);
  if (from > oldest) {
    const chunkFrom = addDays(from, -CHUNK_DAYS) < oldest ? oldest : addDays(from, -CHUNK_DAYS);
    ranges.push([chunkFrom, addDays(from, -1)]);
    from = chunkFrom;
  }
  let rows = 0;
  for (const [a, b] of ranges) {
    const got = await gscQuery(token, site, { startDate: a, endDate: b, dimensions: ["date", "query", "page"] });
    await replaceRange(db, "gsc_rows", ["day", "query", "page", "clicks", "impressions", "pos_sum"], link.app_id, a, b,
      got.map((r) => [r.keys[0], r.keys[1], r.keys[2], r.clicks, r.impressions, r.position * r.impressions]));
    rows += got.length;
  }
  return { gsc_from: from, rows };
}

async function syncGA4(db, token, link, today) {
  const from = link.synced_at ? addDays(today, -RECENT_DAYS + 1) : addDays(today, -TOTALS_DAYS + 1);
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${link.ga4_property}:runReport`;
  const j = await googleJSON(url, token, {
    dateRanges: [{ startDate: from, endDate: "today" }],
    dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }],
    limit: ROW_LIMIT,
  });
  const rows = (j.rows || []).map((r) => {
    const m = r.metricValues.map((v) => Number(v.value) || 0);
    return [gaDay(r.dimensionValues[0].value), r.dimensionValues[1].value || "(not set)", m[0], m[1], m[2], m[3]];
  });
  await replaceRange(db, "ga4_rows", ["day", "channel", "sessions", "users", "engaged", "key_events"], link.app_id, from, addDays(today, 1), rows);
  return rows.length;
}

// syncProject pulls new data for one project. It returns the link as saved
// afterwards, or null when there is nothing linked. A sync already running
// (on another request) is left alone.
export async function syncProject(env, appId, now = Date.now()) {
  const db = env.DB;
  await ensureGoogle(db);
  const sa = serviceAccount(env);
  if (!sa || sa.error) throw new GoogleError(503, sa ? sa.error : "ยังไม่ได้ตั้ง GOOGLE_SERVICE_ACCOUNT ใน Cloudflare");
  const res = await db.prepare("UPDATE google_links SET lock_until = ? WHERE app_id = ? AND lock_until < ?").bind(now + LOCK_MS, appId, now).run();
  const link = await getLink(db, appId);
  if (!link || (!link.gsc_site && !link.ga4_property)) return null;
  const changes = res?.meta?.changes;
  if (changes === 0) return link; // someone else is syncing

  const today = dayStr(now);
  let gscFrom = link.gsc_from;
  let gscErr = "";
  let gaErr = "";
  let token;
  try {
    token = await accessToken(sa, now);
  } catch (e) {
    gscErr = gaErr = e.message;
  }
  if (token && link.gsc_site) {
    try {
      gscFrom = (await syncGSC(db, token, link, today)).gsc_from;
    } catch (e) {
      gscErr = e.message;
    }
  }
  if (token && link.ga4_property) {
    try {
      await syncGA4(db, token, link, today);
    } catch (e) {
      gaErr = e.message;
    }
  }
  // A failed first sync stays "never synced", so the next one starts over.
  const ok = (!link.gsc_site || !gscErr) && (!link.ga4_property || !gaErr);
  await db.prepare("UPDATE google_links SET synced_at = ?, lock_until = 0, gsc_from = ?, gsc_error = ?, ga4_error = ? WHERE app_id = ?")
    .bind(ok || link.synced_at ? now : 0, gscFrom, gscErr.slice(0, 500), gaErr.slice(0, 500), appId).run();
  return getLink(db, appId);
}

// ---- Report ----------------------------------------------------------------

const sumRow = (r) => ({
  clicks: r?.clicks || 0,
  impressions: r?.impressions || 0,
  ctr: r?.impressions ? r.clicks / r.impressions : 0,
  position: r?.impressions ? r.pos_sum / r.impressions : 0,
});

function pathOf(page) {
  try {
    return new URL(page).pathname || "/";
  } catch {
    return page;
  }
}

// statusOf is the part of a link the dashboard and admin pages show.
export function statusOf(env, link, now = Date.now()) {
  const sa = serviceAccount(env);
  return {
    service_account: sa && !sa.error ? sa.email : "",
    setup_error: sa?.error || "",
    linked: !!(link && (link.gsc_site || link.ga4_property)),
    gsc_site: link?.gsc_site || "",
    ga4_property: link?.ga4_property || "",
    synced_at: link?.synced_at ? new Date(link.synced_at).toISOString() : null,
    syncing: !!(link && link.lock_until > now),
    backfilling: needsBackfill(link, now) && !link?.gsc_error,
    gsc_error: link?.gsc_error || "",
    ga4_error: link?.ga4_error || "",
  };
}

// report reads what is stored for days [from, to] (local dates, inclusive)
// and the same number of days before.
export async function report(env, appId, r, off, now = Date.now()) {
  const db = env.DB;
  const link = await getLink(db, appId);
  const out = { ...statusOf(env, link, now), gsc: null, ga4: null };
  if (!out.linked) return out;
  let from = localDay(r.from, off);
  let to = localDay(r.to - 1, off);
  const gaFrom = from, gaTo = to; // GA4 has no lag: same days as gstats
  const n = Math.round((localMidnight(r.to - 1, off) - localMidnight(r.from, off)) / DAY) + 1;
  // Search Console lags 1-3 days. Use the last n days Google has, so the
  // chart does not end in empty days and both periods are full.
  let last = null;
  if (link.gsc_site) {
    last = (await db.prepare("SELECT MAX(day) AS day FROM gsc_totals WHERE app_id = ?").bind(appId).first())?.day || null;
    if (last && last < to) {
      to = last;
      from = addDays(last, -n + 1);
    }
  }
  const pFrom = addDays(from, -n);
  const pTo = addDays(from, -1);

  if (link.gsc_site) {
    const tot = `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(pos_sum) AS pos_sum FROM gsc_totals WHERE app_id = ? AND day BETWEEN ? AND ?`;
    const [cur, prev, daily, queries, pages, prevQ] = await Promise.all([
      db.prepare(tot).bind(appId, from, to).first(),
      db.prepare(tot).bind(appId, pFrom, pTo).first(),
      db.prepare("SELECT day, clicks, impressions, pos_sum FROM gsc_totals WHERE app_id = ? AND day BETWEEN ? AND ? ORDER BY day").bind(appId, from, to).all(),
      db.prepare(`SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(pos_sum) AS pos_sum
                  FROM gsc_rows WHERE app_id = ? AND day BETWEEN ? AND ? GROUP BY query
                  ORDER BY clicks DESC, impressions DESC LIMIT 200`).bind(appId, from, to).all(),
      db.prepare(`SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(pos_sum) AS pos_sum
                  FROM gsc_rows WHERE app_id = ? AND day BETWEEN ? AND ? GROUP BY page
                  ORDER BY clicks DESC, impressions DESC LIMIT 50`).bind(appId, from, to).all(),
      db.prepare(`SELECT query, SUM(clicks) AS clicks FROM gsc_rows WHERE app_id = ? AND day BETWEEN ? AND ? GROUP BY query`).bind(appId, pFrom, pTo).all(),
    ]);
    const prevClicks = new Map((prevQ.results || []).map((q) => [q.query, q.clicks]));
    const byDay = new Map((daily.results || []).map((d) => [d.day, d]));
    const trend = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const x = byDay.get(d);
      trend.push({ t: d, clicks: x?.clicks || 0, impressions: x?.impressions || 0 });
    }
    const qs = (queries.results || []).map((q) => ({ query: q.query, ...sumRow(q), previous: prevClicks.get(q.query) || 0 }));
    out.gsc = {
      totals: sumRow(cur),
      previous: sumRow(prev),
      from, to,
      last_day: last,
      trend,
      queries: qs.slice(0, 50),
      // Shown on page 2 or low on page 1, with people seeing them: the
      // cheapest rankings to improve.
      opportunities: qs.filter((q) => q.position >= 4 && q.position <= 20 && q.impressions >= 5)
        .sort((a, b) => b.impressions - a.impressions).slice(0, 10),
      pages: (pages.results || []).map((p) => ({ page: p.page, path: pathOf(p.page), ...sumRow(p) })),
    };
  }

  if (link.ga4_property) {
    const q = `SELECT channel, SUM(sessions) AS sessions, SUM(users) AS users, SUM(engaged) AS engaged, SUM(key_events) AS key_events
               FROM ga4_rows WHERE app_id = ? AND day BETWEEN ? AND ? GROUP BY channel`;
    const [cur, prev] = await Promise.all([db.prepare(q).bind(appId, gaFrom, gaTo).all(), db.prepare(q).bind(appId, addDays(gaFrom, -n), addDays(gaFrom, -1)).all()]);
    const prevBy = new Map((prev.results || []).map((c) => [c.channel, c]));
    const channels = (cur.results || []).map((c) => ({
      channel: c.channel, sessions: c.sessions, engaged: c.engaged, key_events: c.key_events,
      engagement_rate: c.sessions ? c.engaged / c.sessions : 0, previous: prevBy.get(c.channel)?.sessions || 0,
    })).sort((a, b) => b.sessions - a.sessions);
    const sum = (list, k) => list.reduce((a, c) => a + (c[k] || 0), 0);
    out.ga4 = {
      sessions: sum(channels, "sessions"),
      previous: sum(prev.results || [], "sessions"),
      key_events: sum(channels, "key_events"),
      engaged: sum(channels, "engaged"),
      channels,
    };
  }
  return out;
}
