// Traffic channels and the SEO report, ported from internal/query/seo.go.
import { DAY, localDay, localMidnight } from "./time.js";

export const ORGANIC = "Organic Search";
export const AI = "AI";
export const SOCIAL = "Social";
export const PAID = "Paid";
export const EMAIL = "Email";
export const REFERRAL = "Referral";
export const DIRECT = "Direct";
export const CHANNELS = [ORGANIC, AI, SOCIAL, REFERRAL, PAID, EMAIL, DIRECT];

const aiHosts = ["chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai",
  "gemini.google.com", "bard.google.com", "copilot.microsoft.com", "you.com", "phind.com",
  "poe.com", "chat.deepseek.com", "grok.com", "meta.ai", "chat.mistral.ai"];
const searchHosts = ["google.com", "google.co.th", "bing.com", "duckduckgo.com", "search.yahoo.com",
  "yahoo.com", "baidu.com", "yandex.ru", "yandex.com", "naver.com", "ecosia.org", "search.brave.com",
  "qwant.com", "sogou.com", "seznam.cz", "startpage.com"];
const socialHosts = ["facebook.com", "fb.com", "l.facebook.com", "lm.facebook.com", "instagram.com",
  "t.co", "x.com", "twitter.com", "line.me", "tiktok.com", "youtube.com", "youtu.be", "reddit.com",
  "linkedin.com", "lnkd.in", "pinterest.com", "discord.com", "threads.net", "messenger.com",
  "telegram.org", "t.me", "twitch.tv", "pantip.com"];
const aiSources = ["chatgpt", "chatgpt.com", "openai", "perplexity", "claude", "gemini", "copilot"];
const socialSources = ["facebook", "fb", "instagram", "ig", "twitter", "x", "line", "tiktok", "youtube", "reddit", "linkedin", "discord", "threads"];
const paidMediums = ["cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-social", "paid_social", "cpm", "ads", "display"];

const bare = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

function hostIs(host, list) {
  host = bare(host);
  return list.some((h) => host === h || host.endsWith("." + h));
}

function isSearchHost(host) {
  if (hostIs(host, searchHosts)) return true;
  host = bare(host);
  return ["google.", "bing.", "yahoo.", "yandex."].some((p) => host.startsWith(p) || host.includes("." + p));
}

const inList = (v, list) => list.includes(String(v || "").toLowerCase());
const eq = (a, b) => String(a || "").toLowerCase() === b;

// channel classifies a visit. AI is checked before search because
// gemini.google.com is also a Google host.
export function channel(referrer, utmSource, utmMedium) {
  let ref = String(referrer || "").toLowerCase();
  if (ref === "$direct") ref = "";
  if ((ref && hostIs(ref, aiHosts)) || inList(utmSource, aiSources)) return AI;
  if (inList(utmMedium, paidMediums)) return PAID;
  if (eq(utmMedium, "email") || inList(utmSource, ["email", "newsletter"])) return EMAIL;
  if ((ref && isSearchHost(ref)) || eq(utmMedium, "organic")) return ORGANIC;
  if ((ref && hostIs(ref, socialHosts)) || eq(utmMedium, "social") || inList(utmSource, socialSources)) return SOCIAL;
  if (ref || utmSource) return REFERRAL;
  return DIRECT;
}

function visitSource(ref, utmSource) {
  if (ref && ref !== "$direct") return bare(ref);
  if (utmSource) return String(utmSource).toLowerCase();
  return "(direct)";
}

const byCountThenName = (k, n) => (a, b) => b[k] - a[k] || (a[n] < b[n] ? -1 : a[n] > b[n] ? 1 : 0);

// buildSEO aggregates visit rows of the current and previous period.
export function buildSEO(cur, prev, r, off) {
  const rep = { sessions: 0, previous: 0, channels: [], trend: [], sources: [], landing: [] };
  const ch = {};
  const chBounce = {};
  for (const c of CHANNELS) {
    ch[c] = { channel: c, sessions: 0, previous: 0, bounce_rate: 0 };
    chBounce[c] = 0;
  }
  const src = new Map();
  const land = new Map();
  const landBounce = new Map();
  const days = {};
  for (const v of cur) {
    const c = channel(v.referrer, v.utmSource, v.utmMedium);
    rep.sessions += v.sessions;
    ch[c].sessions += v.sessions;
    chBounce[c] += v.bounces;
    (days[v.day] ||= {})[c] = (days[v.day][c] || 0) + v.sessions;
    if (c !== DIRECT) {
      const k = visitSource(v.referrer, v.utmSource);
      if (!src.has(k)) src.set(k, { source: k, channel: c, sessions: 0, previous: 0 });
      src.get(k).sessions += v.sessions;
    }
    const page = v.landing || "/";
    if (!land.has(page)) land.set(page, { page, sessions: 0, search: 0, ai: 0, bounce_rate: 0, previous: 0 });
    const l = land.get(page);
    l.sessions += v.sessions;
    landBounce.set(page, (landBounce.get(page) || 0) + v.bounces);
    if (c === ORGANIC) l.search += v.sessions;
    if (c === AI) l.ai += v.sessions;
  }
  for (const v of prev) {
    const c = channel(v.referrer, v.utmSource, v.utmMedium);
    rep.previous += v.sessions;
    ch[c].previous += v.sessions;
    if (c !== DIRECT) {
      const s = src.get(visitSource(v.referrer, v.utmSource));
      if (s) s.previous += v.sessions;
    }
    const l = land.get(v.landing || "/");
    if (l) l.previous += v.sessions;
  }
  for (const c of CHANNELS) {
    if (ch[c].sessions > 0) ch[c].bounce_rate = chBounce[c] / ch[c].sessions;
    rep.channels.push(ch[c]);
  }
  rep.sources = [...src.values()].sort(byCountThenName("sessions", "source")).slice(0, 20);
  for (const [p, l] of land) if (l.sessions > 0) l.bounce_rate = landBounce.get(p) / l.sessions;
  rep.landing = [...land.values()].sort(byCountThenName("sessions", "page")).slice(0, 25);
  for (let d = localMidnight(r.from, off); d < r.to; d += DAY) {
    const k = localDay(d, off);
    const channels = {};
    for (const c of CHANNELS) channels[c] = days[k]?.[c] || 0;
    rep.trend.push({ t: k, channels });
  }
  return rep;
}

// Core Web Vitals thresholds (Google): good at or below the first value,
// poor above the second.
const thresholds = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };
export const VITAL_NAMES = ["lcp", "inp", "cls", "fcp", "ttfb"];

export function rate(metric, v) {
  const t = thresholds[metric];
  if (!t) return "";
  if (v <= t[0]) return "good";
  if (v <= t[1]) return "needs-improvement";
  return "poor";
}
