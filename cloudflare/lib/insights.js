// Rule-based insights, ported from internal/query/insights.go. Kind and
// params are data; the dashboard turns them into Thai sentences.
import { AI, ORGANIC, SOCIAL } from "./seo.js";

const levelOrder = { bad: 0, warn: 1, good: 2, info: 3 };
const round1 = (x) => Math.round(x * 10) / 10;

export function pct(cur, prev) {
  if (!prev) return 0;
  return Math.round((cur / prev - 1) * 1000) / 10;
}

// in: {days, cur, prev, seo, vitals, eventsCur, eventsPrev, daily, cohorts}
export function buildInsights(input) {
  const out = [];
  const add = (kind, level, params) => out.push({ kind, level, params: params ?? null });
  const { cur, prev, seo, vitals } = input;

  // 0. Little or no traffic.
  if (cur.events === 0) add("no_data", "warn", { days: input.days });
  else if (cur.visitors < 20) add("low_traffic", "info", { visitors: cur.visitors, days: input.days });

  // 0b. Do people come back the following week?
  let size = 0, back = 0;
  for (const c of input.cohorts || []) {
    if (c.users.length >= 2) {
      size += c.size;
      back += c.users[1];
    }
  }
  if (size >= 20) {
    const r = back / size;
    const p = { pct: round1(r * 100), users: size };
    if (r < 0.15) add("low_return", "warn", p);
    else if (r >= 0.35) add("high_return", "good", p);
  }

  // 1. Visitors versus the previous period.
  if (prev.visitors >= 20 || cur.visitors >= 20) {
    if (prev.visitors === 0) add("traffic_new", "good", { visitors: cur.visitors, days: input.days });
    else {
      const p = pct(cur.visitors, prev.visitors);
      if (p >= 20) add("traffic_up", "good", { pct: p, visitors: cur.visitors, days: input.days });
      else if (p <= -20) add("traffic_down", "warn", { pct: p, visitors: cur.visitors, days: input.days });
    }
  }

  // 2. Yesterday against the 7 days before it.
  const daily = input.daily || [];
  if (daily.length >= 8) {
    const n = daily.length;
    const avg = daily.slice(n - 8, n - 1).reduce((a, d) => a + d.users, 0) / 7;
    const y = daily[n - 1];
    if (avg >= 10) {
      const ratio = y.users / avg;
      const p = { day: y.t, users: y.users, avg: Math.round(avg), pct: round1((ratio - 1) * 100) };
      if (ratio <= 0.6) add("day_drop", "bad", p);
      else if (ratio >= 2) add("day_spike", "good", p);
    }
  }

  // 3. Channels.
  for (const c of seo.channels) {
    if (c.channel !== ORGANIC && c.channel !== AI && c.channel !== SOCIAL) continue;
    if (c.channel === AI && c.previous === 0 && c.sessions >= 3) add("ai_new", "good", { sessions: c.sessions });
    else if (c.previous >= 10 && pct(c.sessions, c.previous) >= 30)
      add("channel_up", "good", { channel: c.channel, pct: pct(c.sessions, c.previous), sessions: c.sessions });
    else if (c.previous >= 10 && pct(c.sessions, c.previous) <= -30)
      add("channel_down", "warn", { channel: c.channel, pct: pct(c.sessions, c.previous), sessions: c.sessions });
  }
  const organic = seo.channels.find((c) => c.channel === ORGANIC)?.sessions || 0;
  if (seo.sessions >= 50 && organic < 0.05 * seo.sessions)
    add("search_low", "info", { share: round1((organic / seo.sessions) * 100), sessions: seo.sessions });

  // 4. Landing pages.
  let best = null;
  for (const l of seo.landing) {
    if (l.search + l.ai >= 5 && (!best || l.search + l.ai > best.search + best.ai)) best = l;
  }
  if (best) add("top_search_page", "info", { page: best.page, sessions: best.search + best.ai });
  const bouncy = seo.landing.find((l) => l.sessions >= 20 && l.bounce_rate >= 0.7);
  if (bouncy) add("high_bounce", "warn", { page: bouncy.page, rate: Math.round(bouncy.bounce_rate * 100), sessions: bouncy.sessions });

  // 5. Core Web Vitals.
  const worstPage = (metric) => {
    let page = "", worst = 0;
    for (const g of vitals.by_page) for (const v of g.vitals) {
      if (v.metric === metric && v.samples >= 5 && v.p75 > worst) {
        worst = v.p75;
        page = g.key;
      }
    }
    return page;
  };
  for (const g of vitals.by_device) {
    for (const v of g.vitals) {
      if (v.samples < 20 || !["lcp", "inp", "cls"].includes(v.metric)) continue;
      if (v.rating === "poor" || v.rating === "needs-improvement") {
        add("vital_slow", v.rating === "poor" ? "bad" : "warn",
          { metric: v.metric, device: g.key, p75: v.p75, rating: v.rating, page: worstPage(v.metric) });
      }
    }
  }
  if (!vitals.overall.length && cur.pageviews >= 20) add("vitals_missing", "info", null);

  // 6. Custom events that fell or grew sharply.
  const prevMap = new Map((input.eventsPrev || []).map((r) => [r.value, r.events]));
  const curNames = new Set((input.eventsCur || []).map((r) => r.value));
  const drops = [], grows = [];
  for (const r of input.eventsCur || []) {
    if (r.value.startsWith("$")) continue;
    const old = prevMap.get(r.value) || 0;
    if (old >= 50 && r.events <= 0.5 * old) drops.push({ ev: r.value, cur: r.events, old });
    else if (old >= 50 && r.events >= 2 * old) grows.push({ ev: r.value, cur: r.events, old });
  }
  for (const r of input.eventsPrev || []) {
    if (!r.value.startsWith("$") && r.events >= 50 && !curNames.has(r.value)) drops.push({ ev: r.value, cur: 0, old: r.events });
  }
  drops.sort((a, b) => b.old - b.cur - (a.old - a.cur));
  for (const d of drops.slice(0, 2)) add("event_down", "warn", { event: d.ev, count: d.cur, previous: d.old, pct: pct(d.cur, d.old) });
  grows.sort((a, b) => b.cur - b.old - (a.cur - a.old));
  if (grows.length) {
    const g = grows[0];
    add("event_up", "good", { event: g.ev, count: g.cur, previous: g.old, pct: pct(g.cur, g.old) });
  }

  const sorted = out.map((x, i) => [x, i]).sort((a, b) => levelOrder[a[0].level] - levelOrder[b[0].level] || a[1] - b[1]);
  return sorted.slice(0, 10).map((x) => x[0]);
}
