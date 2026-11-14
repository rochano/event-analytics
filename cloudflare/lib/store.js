// D1 queries behind the dashboard API. Each one mirrors a method of the Go
// Store (internal/query/store.go, seo.go) and returns the same JSON shape.
// Every query is scoped by app_id and uses bound parameters only.
import { DAY, fillSeries, localDay, localMonday } from "./time.js";
import { rate, VITAL_NAMES } from "./seo.js";

const offMs = (off) => off * 60000;
const dayExpr = "date((ts + ?) / 1000, 'unixepoch')";
const hourExpr = "strftime('%Y-%m-%d %H:00', (ts + ?) / 1000, 'unixepoch')";

// Dimensions a breakdown may group by (column names, never user input).
export const DIMENSIONS = {
  pathname: "pathname", referrer_domain: "referrer_domain", utm_source: "utm_source",
  country_code: "country_code", device_type: "device_type", browser: "browser", event: "event",
};

async function all(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...args).all();
  return res.results || [];
}

async function first(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) || {};
}

export async function overview(db, appId, r) {
  const a = await first(db,
    `SELECT COUNT(DISTINCT distinct_id) AS v, COALESCE(SUM(event = '$pageview'), 0) AS pv, COUNT(*) AS e
     FROM events WHERE app_id = ? AND ts >= ? AND ts < ?`, appId, r.from, r.to);
  const s = await first(db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(pv <= 1), 0) AS b, AVG((en - st) / 1000.0) AS avg
     FROM (SELECT session_id, MIN(ts) AS st, MAX(ts) AS en, SUM(event = '$pageview') AS pv
           FROM events WHERE app_id = ? AND ts >= ? AND ts < ? AND session_id != ''
           GROUP BY session_id)`, appId, r.from, r.to);
  const n = s.n || 0;
  return {
    visitors: a.v || 0, pageviews: a.pv || 0, events: a.e || 0, sessions: n,
    bounce_rate: n ? (s.b || 0) / n : 0, avg_session_secs: s.avg || 0,
  };
}

export async function activeNow(db, appId, now) {
  const r = await first(db, "SELECT COUNT(DISTINCT distinct_id) AS n FROM events WHERE app_id = ? AND ts > ?", appId, now - 5 * 60000);
  return r.n || 0;
}

export async function trend(db, appId, r, event, interval, off) {
  const bucket = interval === "hour" ? hourExpr : dayExpr;
  const rows = await all(db,
    `SELECT ${bucket} AS t, COUNT(*) AS events, COUNT(DISTINCT distinct_id) AS users
     FROM events WHERE app_id = ? AND ts >= ? AND ts < ? AND (? = '' OR event = ?)
     GROUP BY t`, offMs(off), appId, r.from, r.to, event, event);
  const got = {};
  for (const x of rows) got[x.t] = x;
  return fillSeries(got, r, interval, off);
}

export async function breakdown(db, appId, r, dim, event, limit) {
  const col = DIMENSIONS[dim];
  if (!col) throw new Error("unknown dim");
  const rows = await all(db,
    `SELECT ${col} AS value, COUNT(*) AS events, COUNT(DISTINCT distinct_id) AS users
     FROM events WHERE app_id = ? AND ts >= ? AND ts < ? AND (? = '' OR event = ?)
     GROUP BY value ORDER BY events DESC LIMIT ?`, appId, r.from, r.to, event, event, limit);
  return rows.map((x) => ({ value: x.value ?? "", events: x.events, users: x.users }));
}

// funnel counts users who did the steps in order within window seconds,
// like ClickHouse windowFunnel: the deepest step reached from any start.
export async function funnel(db, appId, r, steps, window) {
  const rows = await all(db,
    `SELECT distinct_id AS d, event AS e, ts FROM events
     WHERE app_id = ? AND ts >= ? AND ts < ? AND event IN (${steps.map(() => "?").join(", ")})
     ORDER BY distinct_id, ts LIMIT 500000`, appId, r.from, r.to, ...steps);
  const atLevel = new Array(steps.length + 1).fill(0);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].d === rows[i].d) j++;
    atLevel[funnelLevel(rows.slice(i, j), steps, window * 1000)]++;
    i = j;
  }
  const out = [];
  let cum = 0;
  for (let k = steps.length; k >= 1; k--) {
    cum += atLevel[k];
    out[k - 1] = { event: steps[k - 1], users: cum };
  }
  return out;
}

export function funnelLevel(evs, steps, windowMs) {
  let best = 0;
  for (let i = 0; i < evs.length && best < steps.length; i++) {
    if (evs[i].e !== steps[0]) continue;
    let level = 1;
    for (let j = i + 1; j < evs.length && level < steps.length && evs[j].ts - evs[i].ts <= windowMs; j++) {
      if (evs[j].e === steps[level]) level++;
    }
    best = Math.max(best, level);
  }
  return best;
}

// retention returns weekly cohorts by first-seen week.
export async function retention(db, appId, now, weeks, off) {
  const from = localMonday(now, off) - 7 * (weeks - 1) * DAY;
  const fromDay = localDay(from, off);
  const o = offMs(off);
  const rows = await all(db,
    `WITH cohort AS (
       SELECT distinct_id, date((MIN(ts) + ?) / 1000, 'unixepoch', 'weekday 0', '-6 days') AS cw
       FROM events WHERE app_id = ? GROUP BY distinct_id HAVING cw >= ?
     ), days AS (
       SELECT DISTINCT distinct_id, date((ts + ?) / 1000, 'unixepoch') AS d
       FROM events WHERE app_id = ? AND ts >= ?
     )
     SELECT c.cw AS w,
            CAST(ROUND((julianday(date(days.d, 'weekday 0', '-6 days')) - julianday(c.cw)) / 7) AS INTEGER) AS n,
            COUNT(DISTINCT days.distinct_id) AS u
     FROM days JOIN cohort AS c ON c.distinct_id = days.distinct_id
     GROUP BY w, n HAVING n >= 0 AND n < ?`, o, appId, fromDay, o, appId, from, weeks);
  const byWeek = {};
  for (const x of rows) {
    (byWeek[x.w] ||= new Array(weeks).fill(0))[x.n] = x.u;
  }
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const w = localDay(from + 7 * i * DAY, off);
    const cells = byWeek[w] || new Array(weeks).fill(0);
    out.push({ week: w, size: cells[0], users: cells.slice(0, weeks - i) });
  }
  return out;
}

export async function live(db, appId, now, limit) {
  const rows = await all(db,
    `SELECT ts, event, distinct_id, pathname, country_code, device_type, props FROM events
     WHERE app_id = ? AND ts > ? ORDER BY ts DESC LIMIT ?`, appId, now - DAY, limit);
  return rows.map((x) => ({
    timestamp: new Date(x.ts).toISOString(), event: x.event, distinct_id: x.distinct_id, pathname: x.pathname,
    country: x.country_code, device: x.device_type, properties: x.props,
  }));
}

// visits groups sessions that started in r by day, landing page and
// first-touch source. SQLite returns the other columns from the row that
// holds MIN(ts), which gives first-touch values without argMin.
export async function visits(db, appId, r, off) {
  const rows = await all(db,
    `SELECT date((st + ?) / 1000, 'unixepoch') AS d, landing, ref, src, um, COUNT(*) AS sessions, SUM(bounced) AS bounces
     FROM (
       SELECT session_id, MIN(ts) AS st, pathname AS landing, referrer_domain AS ref,
              utm_source AS src, utm_medium AS um,
              (SUM(event = '$pageview') <= 1 AND SUM(substr(event, 1, 1) != '$') = 0) AS bounced
       FROM events
       WHERE app_id = ? AND ts >= ? AND ts < ? AND session_id != '' AND event NOT IN ('$web_vitals', '$pageleave')
       GROUP BY session_id
       HAVING st >= ?
     )
     GROUP BY d, landing, ref, src, um LIMIT 100000`, offMs(off), appId, r.from - DAY, r.to, r.from);
  return rows.map((x) => ({
    day: x.d, landing: x.landing, referrer: x.ref, utmSource: x.src, utmMedium: x.um,
    sessions: x.sessions, bounces: x.bounces || 0,
  }));
}

// vitals returns p75 Core Web Vitals from $web_vitals events.
export async function vitals(db, appId, r) {
  const rows = await all(db,
    `SELECT device_type AS device, pathname AS page,
            ${VITAL_NAMES.map((m) => `json_extract(props, '$.${m}') AS ${m}`).join(", ")}
     FROM events WHERE app_id = ? AND ts >= ? AND ts < ? AND event = '$web_vitals' LIMIT 100000`, appId, r.from, r.to);
  const group = (keyOf, limit) => {
    const g = new Map();
    for (const x of rows) {
      const k = keyOf(x);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(x);
    }
    return [...g.entries()]
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([key, list]) => ({ key, views: list.length, vitals: p75s(list) }));
  };
  const overall = rows.length ? p75s(rows) : [];
  return { overall, by_device: group((x) => x.device || "", 5), by_page: group((x) => x.page || "", 10) };
}

function p75s(list) {
  const out = [];
  for (const m of VITAL_NAMES) {
    const vals = [];
    for (const x of list) {
      const v = typeof x[m] === "number" ? x[m] : typeof x[m] === "string" && x[m].trim() !== "" ? Number(x[m]) : NaN;
      if (Number.isFinite(v) && v >= 0) vals.push(v);
    }
    if (!vals.length) continue;
    const p = quantile(vals, 0.75);
    out.push({ metric: m, p75: p, rating: rate(m, p), samples: vals.length });
  }
  return out;
}

export function quantile(vals, q) {
  const s = [...vals].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// deleteOld removes rows past the project's retention (run now and then).
export async function deleteOld(db, appId, retentionDays, now) {
  await db.prepare("DELETE FROM events WHERE app_id = ? AND ts < ?").bind(appId, now - retentionDays * DAY).run();
}
