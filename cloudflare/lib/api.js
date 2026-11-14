// Request handlers for the Cloudflare edition: POST /e (ingest) and /api/*
// (dashboard). Same routes, parameters and JSON as the Go services, so the
// dashboard in web/ and every SDK work unchanged.
import { originAllowed, projectsFrom, sameKey, tzLabel, tzOffset } from "./config.js";
import { MAX_EVENTS_PER_BATCH, normalize, parseBatch, readBody } from "./ingest.js";
import { ensureSchema, insertRows } from "./schema.js";
import * as store from "./store.js";
import { buildSEO } from "./seo.js";
import { buildInsights } from "./insights.js";
import { daysRange, previous } from "./time.js";

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
  const proj = projectsFrom(env).find((p) => sameKey(p.writeKey, key));
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
    await insertRows(d, proj.appId, rows);
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

export async function handleApi(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const key = request.headers.get("X-Read-Key") || url.searchParams.get("key") || "";
  const proj = projectsFrom(env).find((p) => p.readKey && sameKey(p.readKey, key));
  if (!proj) return json(401, { error: "invalid read key" });
  const off = tzOffset(env);

  if (route === "config") {
    return json(200, { app_id: proj.appId, name: proj.name, write_key: proj.writeKey, collector_url: url.origin, timezone: tzLabel(off) });
  }
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
      return store.breakdown(d, appId, daysRange(now, days(), off), "event", "", 100);
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
