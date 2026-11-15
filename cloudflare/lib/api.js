// Request handlers for the Cloudflare edition: POST /e (ingest) and /api/*
// (dashboard). Same routes, parameters and JSON as the Go services, so the
// dashboard in web/ and every SDK work unchanged.
import { originAllowed, sameKey, tzLabel, tzOffset } from "./config.js";
import { handleAccount } from "./accounts.js";
import { AdminError, allProjects, byReadKey, byWriteKey, createProject, updateProject } from "./projects.js";
import { MAX_EVENTS_PER_BATCH, normalize, parseBatch, readBody } from "./ingest.js";
import { ensureSchema, insertRows } from "./schema.js";
import * as store from "./store.js";
import { buildSEO } from "./seo.js";
import { buildInsights } from "./insights.js";
import { daysRange, previous } from "./time.js";
import { addUsage, forgetUsage, monthOf, overQuota } from "./usage.js";
import { ACCOUNTS_SCHEMA } from "./accounts.js";
import * as google from "./google.js";

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const text = (status, msg, headers = {}) => new Response(msg, { status, headers: { "Content-Type": "text/plain", ...headers } });

function db(env) {
  if (!env.DB) throw Object.assign(new Error("D1 binding DB is missing (Pages > Settings > Bindings)"), { status: 500 });
  return env.DB;
}

// ---- Ingest ------------------------------------------------------------------

export async function handleIngest(request, env, waitUntil = () => {}) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Content-Encoding, X-Api-Key",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }
  if (request.method !== "POST") return text(405, "method not allowed", { Allow: "POST, OPTIONS" });
  const receivedAt = Date.now();

  let parsed;
  try {
    parsed = parseBatch(await readBody(request));
  } catch (e) {
    return text(e.status || 400, e.message);
  }
  const url = new URL(request.url);
  const key = request.headers.get("X-Api-Key") || url.searchParams.get("k") || parsed.apiKey;
  const proj = key ? await byWriteKey(env, key) : null;
  if (!proj) return text(401, "unknown project key");

  const origin = request.headers.get("Origin") || "";
  // The dashboard's own "send test event" button posts from this origin.
  const originOK = !origin || origin === url.origin || originAllowed(proj.origins, origin);
  const cors = origin && originOK ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};

  if (!parsed.events.length || parsed.events.length > MAX_EVENTS_PER_BATCH) {
    return text(400, `batch must hold 1 to ${MAX_EVENTS_PER_BATCH} events`, cors);
  }
  // Answer like success so scrapers learn nothing; drop the events.
  if (!originOK) return new Response(null, { status: 204 });

  const sentAtRaw = parsed.sentAt || url.searchParams.get("sent_at") || "";
  const sentAt = sentAtRaw ? Date.parse(sentAtRaw) : 0;
  const meta = {
    receivedAt,
    sentAt: Number.isFinite(sentAt) ? sentAt : 0,
    userAgent: request.headers.get("User-Agent") || "",
    country: request.cf?.country || request.headers.get("CF-IPCountry") || "",
  };
  const rows = [];
  for (const ev of parsed.events) {
    try {
      rows.push(normalize(ev, proj.appId, meta));
    } catch {
      // Invalid events are dropped, like the Go collector's dead-letter path.
    }
  }
  try {
    const d = db(env);
    await ensureSchema(d);
    const off = tzOffset(env);
    if (proj.ownerId && (await overQuota(d, proj.ownerId, receivedAt, off))) {
      return text(402, "monthly event quota reached", cors);
    }
    await insertRows(d, proj.appId, rows);
    if (proj.ownerId) await addUsage(d, proj.ownerId, rows.length, receivedAt, off).catch((e) => console.error("usage failed", e && e.message));
    // Now and then, delete rows past the retention period.
    if (Math.random() < 0.005) waitUntil(store.deleteOld(d, proj.appId, proj.retentionDays, receivedAt).catch(() => {}));
  } catch (e) {
    console.error("insert failed", e && e.message);
    return text(503, "temporarily unavailable", { "Retry-After": "5", ...cors });
  }
  return new Response(null, { status: 204, headers: cors });
}

// ---- Dashboard API -------------------------------------------------------------

class BadRequest extends Error {}

// Small in-memory cache per isolate: repeated dashboard loads reuse results
// instead of reading the same D1 rows again (D1's free plan counts rows read).
const cache = new Map();
const TTL = {
  overview: 60, trend: 60, breakdown: 60, events: 300, funnel: 120, retention: 600,
  live: 3, seo: 120, vitals: 300, insights: 300,
};

function intParam(q, name, def, lo, hi, msg) {
  const s = q.get(name);
  if (s == null || s === "") return def;
  const v = Number(s);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new BadRequest(msg);
  return v;
}

export async function handleApi(request, env, now = Date.now(), waitUntil = (p) => p.catch(() => {})) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  if (route === "admin" || route.startsWith("admin/")) return handleAdmin(request, env, route.slice(6), now);
  if (route.startsWith("account/")) return handleAccount(request, env, route.slice(8), now);
  const key = request.headers.get("X-Read-Key") || url.searchParams.get("key") || "";
  const proj = key ? await byReadKey(env, key) : null;
  if (!proj) return json(401, { error: "invalid read key" });
  const off = tzOffset(env);

  if (route === "config") {
    return json(200, { app_id: proj.appId, name: proj.name, write_key: proj.writeKey, collector_url: url.origin, timezone: tzLabel(off) });
  }
  if (route === "google" || route === "google/sync") return handleGoogle(request, env, route, proj, off, now, waitUntil);
  if (!TTL[route]) return json(404, { error: "not found" });

  const q = new URLSearchParams(url.searchParams);
  q.delete("key");
  q.sort();
  const ck = `${proj.appId}|${route}?${q}`;
  const hit = cache.get(ck);
  if (hit && hit.exp > now) return new Response(hit.body, { headers: { "Content-Type": "application/json", "X-Cache": "hit" } });

  let data;
  try {
    const d = db(env);
    await ensureSchema(d);
    data = await compute(route, url.searchParams, d, proj.appId, off, now);
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message });
    console.error("query failed", route, e && e.message);
    return json(e.status || 500, { error: e.status ? e.message : "query failed" });
  }
  const body = JSON.stringify({ data, computed_at: new Date(now).toISOString() });
  if (cache.size > 2000) cache.clear();
  cache.set(ck, { body, exp: now + TTL[route] * 1000 });
  return new Response(body, { headers: { "Content-Type": "application/json", "X-Cache": "miss" } });
}

async function compute(route, q, d, appId, off, now) {
  const days = () => intParam(q, "days", 30, 1, 400, "days must be 1..400");
  switch (route) {
    case "overview": {
      const r = daysRange(now, days(), off);
      const [current, prev, active] = await Promise.all([
        store.overview(d, appId, r), store.overview(d, appId, previous(r)), store.activeNow(d, appId, now),
      ]);
      return { current, previous: prev, active_now: active };
    }
    case "trend": {
      const r = daysRange(now, days(), off);
      return store.trend(d, appId, r, q.get("event") || "", q.get("interval") === "hour" ? "hour" : "day", off);
    }
    case "breakdown": {
      const r = daysRange(now, days(), off);
      const dim = q.get("dim") || "";
      if (!store.DIMENSIONS[dim]) throw new BadRequest("unknown dim");
      let limit = Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) limit = 10;
      return store.breakdown(d, appId, r, dim, q.get("event") || "", limit);
    }
    case "events":
      return store.eventNames(d, appId, daysRange(now, days(), off), 100);
    case "funnel": {
      const r = daysRange(now, days(), off);
      const steps = (q.get("steps") || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (steps.length < 2 || steps.length > 8) throw new BadRequest("steps: give 2 to 8 comma-separated event names");
      const window = intParam(q, "window", 86400, 60, 30 * 86400, "window must be 60..2592000 seconds");
      return store.funnel(d, appId, r, steps, window);
    }
    case "retention":
      return store.retention(d, appId, now, intParam(q, "weeks", 8, 2, 26, "weeks must be 2..26"), off);
    case "live": {
      let limit = Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit <= 0 || limit > 200) limit = 30;
      const [events, active] = await Promise.all([store.live(d, appId, now, limit), store.activeNow(d, appId, now)]);
      return { events, active_now: active };
    }
    case "seo": {
      const r = daysRange(now, days(), off);
      const [cur, prev] = await Promise.all([store.visits(d, appId, r, off), store.visits(d, appId, previous(r), off)]);
      return buildSEO(cur, prev, r, off);
    }
    case "vitals":
      return store.vitals(d, appId, daysRange(now, days(), off));
    case "insights": {
      const n = days();
      const r = daysRange(now, n, off);
      const p = previous(r);
      const [cur, prev, vc, vp, vitals, eventsCur, eventsPrev, daily, cohorts] = await Promise.all([
        store.overview(d, appId, r), store.overview(d, appId, p),
        store.visits(d, appId, r, off), store.visits(d, appId, p, off),
        store.vitals(d, appId, r),
        store.breakdown(d, appId, r, "event", "", 100), store.breakdown(d, appId, p, "event", "", 100),
        store.trend(d, appId, daysRange(now, 9, off), "", "day", off),
        store.retention(d, appId, now, 5, off),
      ]);
      return buildInsights({
        days: n, cur, prev, seo: buildSEO(vc, vp, r, off), vitals, eventsCur, eventsPrev,
        daily: daily.slice(0, -1), // drop today, which is not over yet
        cohorts,
      });
    }
  }
  throw new BadRequest("unknown route");
}

// ---- Google Search Console and GA4 (read key) ---------------------------------

// GET /api/google?days=N: stored Search Console and GA4 numbers, and a sync in
// the background when one is due. POST /api/google/sync: sync now (at most
// every 10 minutes, or one backfill chunk at a time) and return the status.
async function handleGoogle(request, env, route, proj, off, now, waitUntil) {
  try {
    const d = db(env);
    await google.ensureGoogle(d);
    const link = await google.getLink(d, proj.appId);
    const canSync = google.serviceAccount(env) && !google.serviceAccount(env).error;
    if (route === "google/sync") {
      if (request.method !== "POST") return json(405, { error: "use POST" });
      let after = link;
      if (canSync && google.due(link, now, google.MANUAL_EVERY_MS)) after = await google.syncProject(env, proj.appId, now);
      clearCache(proj.appId);
      return json(200, { data: google.statusOf(env, after, now) });
    }
    const q = new URL(request.url).searchParams;
    const days = intParam(q, "days", 30, 1, 400, "days must be 1..400");
    if (canSync && google.due(link, now) && !google.needsBackfill(link, now)) {
      waitUntil(google.syncProject(env, proj.appId, now).catch((e) => console.error("google sync failed", e && e.message)));
    }
    return json(200, { data: await google.report(env, proj.appId, daysRange(now, days, off), off, now), computed_at: new Date(now).toISOString() });
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message });
    if (e instanceof google.GoogleError) return json(e.status, { error: e.message });
    console.error("google failed", e && e.message);
    return json(500, { error: "query failed" });
  }
}

function clearCache(appId) {
  for (const k of cache.keys()) if (k.startsWith(appId + "|")) cache.delete(k);
}

// ---- Admin: list, add and edit projects (needs the ADMIN_KEY secret) -----------

const publicProject = (p) => ({
  app_id: p.appId, name: p.name || "", write_key: p.writeKey, read_key: p.readKey,
  origins: p.origins, retention_days: p.retentionDays, source: p.source, editable: p.source === "db",
});

async function handleAdmin(request, env, sub, now = Date.now()) {
  if (!env.ADMIN_KEY) return json(503, { error: "ยังไม่ได้ตั้ง ADMIN_KEY (Settings > Variables and Secrets)" });
  if (!sameKey(String(env.ADMIN_KEY).trim(), request.headers.get("X-Admin-Key") || "")) return json(401, { error: "รหัสผู้ดูแลไม่ถูกต้อง" });
  try {
    db(env);
    if (sub === "projects" && request.method === "GET") {
      return json(200, { data: (await allProjects(env)).map(publicProject) });
    }
    if (sub === "projects" && request.method === "POST") {
      return json(201, { data: publicProject(await createProject(env, await request.json().catch(() => ({})))) });
    }
    const m = /^projects\/(\d+)$/.exec(sub);
    if (m && request.method === "PATCH") {
      return json(200, { data: publicProject(await updateProject(env, Number(m[1]), await request.json().catch(() => ({})))) });
    }
    if (sub === "google" && request.method === "GET") {
      const links = new Map((await google.allLinks(db(env))).map((l) => [l.app_id, l]));
      const projects = await allProjects(env);
      const st = google.statusOf(env, null, now);
      return json(200, { data: {
        service_account: st.service_account, setup_error: st.setup_error,
        projects: projects.map((p) => ({ app_id: p.appId, name: p.name || "", ...google.statusOf(env, links.get(p.appId), now) })),
      } });
    }
    const mg = /^google\/(\d+)(\/sync)?$/.exec(sub);
    if (mg && !mg[2] && request.method === "PUT") {
      const appId = Number(mg[1]);
      if (!(await allProjects(env)).some((p) => p.appId === appId)) throw new AdminError(404, "ไม่พบโปรเจกต์");
      let link = await google.setLink(db(env), appId, await request.json().catch(() => ({})));
      // Try right away, so a missing permission shows up now.
      if (google.serviceAccount(env) && !google.serviceAccount(env).error && (link.gsc_site || link.ga4_property)) {
        link = await google.syncProject(env, appId, now);
      }
      clearCache(appId);
      return json(200, { data: { app_id: appId, ...google.statusOf(env, link, now) } });
    }
    if (mg && mg[2] && request.method === "POST") {
      const appId = Number(mg[1]);
      const link = await google.syncProject(env, appId, now);
      if (!link) throw new AdminError(404, "โปรเจกต์นี้ยังไม่ได้เชื่อม Google");
      clearCache(appId);
      return json(200, { data: { app_id: appId, ...google.statusOf(env, link, now) } });
    }
    // For an outside scheduler (e.g. a GitHub Actions cron): sync what is due.
    if (sub === "google/sync" && request.method === "POST") {
      const done = [];
      for (const l of await google.allLinks(db(env))) {
        if (done.length >= 3) break; // keep one request short; call again for more
        if (google.due(l, now)) done.push((await google.syncProject(env, l.app_id, now).catch(() => null))?.app_id ?? l.app_id);
      }
      return json(200, { data: { synced: done } });
    }
    if (sub === "users" && request.method === "GET") {
      const d = db(env);
      await d.batch(ACCOUNTS_SCHEMA.map((q) => d.prepare(q)));
      const month = monthOf(Date.now(), tzOffset(env));
      const res = await d.prepare(
        `SELECT u.id, u.email, u.event_quota AS quota, u.created_at, COALESCE(g.events, 0) AS used,
                (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS projects
         FROM users u LEFT JOIN usage g ON g.owner_id = u.id AND g.month = ?
         ORDER BY used DESC, u.id LIMIT 500`,
      ).bind(month).all().catch(() => ({ results: [] }));
      return json(200, { data: { month, users: res.results || [] } });
    }
    const mu = /^users\/(\d+)$/.exec(sub);
    if (mu && request.method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const q = Number(body.event_quota);
      if (!Number.isInteger(q) || q < 0 || q > 1e10) throw new AdminError(400, "โควตาต้องเป็นจำนวนเต็ม 0 ขึ้นไป");
      await db(env).prepare("UPDATE users SET event_quota = ? WHERE id = ?").bind(q, Number(mu[1])).run();
      forgetUsage(Number(mu[1]));
      return json(200, { data: { id: Number(mu[1]), event_quota: q } });
    }
    return json(404, { error: "not found" });
  } catch (e) {
    if (e instanceof AdminError || e instanceof google.GoogleError || e.status) return json(e.status || 400, { error: e.message });
    console.error("admin failed", e && e.message);
    return json(500, { error: "admin failed" });
  }
}
