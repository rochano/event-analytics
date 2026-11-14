import test from "node:test";
import assert from "node:assert/strict";
import { normalize, parseBatch, referrerDomain } from "../lib/ingest.js";
import { channel, buildSEO, rate } from "../lib/seo.js";
import { daysRange, localMonday, localDay, fillSeries } from "../lib/time.js";
import { funnelLevel, quantile } from "../lib/store.js";
import { buildInsights } from "../lib/insights.js";
import { originAllowed, parseProjects } from "../lib/config.js";

test("parseBatch accepts array, object and envelope", () => {
  assert.equal(parseBatch('[{"event":"a"}]').events.length, 1);
  assert.equal(parseBatch('{"event":"a"}').events[0].event, "a");
  const env = parseBatch('{"api_key":"k","sent_at":"2026-11-14T00:00:00Z","batch":[{"event":"a"},{"event":"b"}]}');
  assert.deepEqual([env.apiKey, env.events.length], ["k", 2]);
  assert.throws(() => parseBatch(""), /empty/);
  assert.throws(() => parseBatch("{"), /bad json/);
});

test("normalize derives fields like the Go collector", () => {
  const now = Date.parse("2026-11-14T08:00:00Z");
  const row = normalize({
    event: "$pageview", distinct_id: "u1", session_id: "s1",
    timestamp: "2026-11-14T07:59:00Z",
    properties: {
      $current_url: "https://game.example.com/play?utm_source=chatgpt.com&utm_medium=x",
      $referrer: "https://www.google.co.th/search?q=x",
      $user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
    },
  }, 1, { receivedAt: now, sentAt: now - 2000, country: "th" }, () => "id");
  assert.equal(row.pathname, "/play");
  assert.equal(row.utm_source, "chatgpt.com");
  assert.equal(row.referrer_domain, "google.co.th");
  assert.equal(row.country_code, "TH");
  assert.deepEqual([row.device_type, row.os, row.browser], ["Mobile", "iOS", "Safari"]);
  assert.equal(row.ts, Date.parse("2026-11-14T07:59:02Z")); // clock skew corrected
  assert.equal(row.uuid, "id");
  assert.throws(() => normalize({ event: "x" }, 1, { receivedAt: now }), /distinct_id/);
  assert.throws(() => normalize({ event: "x", distinct_id: "u", timestamp: "2026-10-01T00:00:00Z" }, 1, { receivedAt: now }), /older/);
  assert.throws(() => normalize({ event: "x", distinct_id: "u", properties: { "bad key": 1 } }, 1, { receivedAt: now }), /property key/);
  assert.equal(referrerDomain("https://game.example.com/a", "https://game.example.com/b"), "$direct");
});

test("channel matches the Go classifier", () => {
  const cases = [
    ["google.com", "", "", "Organic Search"], ["www.google.co.th", "", "", "Organic Search"], ["google.de", "", "", "Organic Search"],
    ["gemini.google.com", "", "", "AI"], ["chatgpt.com", "", "", "AI"], ["$direct", "chatgpt.com", "", "AI"],
    ["m.facebook.com", "", "", "Social"], ["t.co", "", "", "Social"], ["$direct", "line", "social", "Social"],
    ["google.com", "google", "cpc", "Paid"], ["$direct", "newsletter", "email", "Email"],
    ["itch.io", "", "", "Referral"], ["$direct", "partner-site", "", "Referral"], ["$direct", "", "", "Direct"],
    ["", "", "", "Direct"], ["notgoogle.com", "", "", "Referral"], ["evilchatgpt.com", "", "", "Referral"],
  ];
  for (const [ref, src, med, want] of cases) assert.equal(channel(ref, src, med), want, `${ref} ${src} ${med}`);
});

test("buildSEO aggregates like the Go version", () => {
  const off = 420;
  const r = { from: Date.parse("2026-11-09T17:00:00Z"), to: Date.parse("2026-11-11T10:00:00Z") };
  const cur = [
    { day: "2026-11-10", landing: "/about.html", referrer: "google.com", sessions: 8, bounces: 2 },
    { day: "2026-11-10", landing: "/", referrer: "$direct", sessions: 5, bounces: 5 },
    { day: "2026-11-11", landing: "/about.html", referrer: "chatgpt.com", sessions: 3, bounces: 0 },
    { day: "2026-11-11", landing: "", referrer: "m.facebook.com", sessions: 4, bounces: 1 },
  ];
  const prev = [{ day: "2026-11-08", landing: "/about.html", referrer: "google.com", sessions: 2, bounces: 0 }];
  const rep = buildSEO(cur, prev, r, off);
  assert.equal(rep.sessions, 20);
  assert.equal(rep.previous, 2);
  const by = Object.fromEntries(rep.channels.map((c) => [c.channel, c]));
  assert.equal(by["Organic Search"].sessions, 8);
  assert.equal(by["Organic Search"].previous, 2);
  assert.equal(by.Direct.bounce_rate, 1);
  assert.deepEqual(rep.trend.map((p) => p.t), ["2026-11-10", "2026-11-11"]);
  assert.equal(rep.landing[0].page, "/about.html");
  assert.equal(rep.landing[0].search, 8);
  assert.equal(rep.landing[0].ai, 3);
  assert.equal(rep.sources.find((s) => s.source === "m.facebook.com").channel, "Social");
});

test("time helpers use the fixed offset", () => {
  const now = Date.parse("2026-11-14T20:00:00Z"); // 03:00 on the 15th in Bangkok
  const r = daysRange(now, 2, 420);
  assert.equal(new Date(r.from).toISOString(), "2026-11-13T17:00:00.000Z");
  assert.equal(localDay(localMonday(now, 420), 420), "2026-11-09"); // the 15th is a Sunday
  assert.equal(fillSeries({}, r, "day", 420).length, 2);
  assert.equal(fillSeries({}, { from: r.from, to: r.from + 3 * 3600000 }, "hour", 420)[0].t, "2026-11-14 00:00");
});

test("funnel level and quantile", () => {
  const steps = ["a", "b", "c"];
  assert.equal(funnelLevel([{ e: "a", ts: 0 }, { e: "b", ts: 10 }, { e: "c", ts: 20 }], steps, 100), 3);
  assert.equal(funnelLevel([{ e: "a", ts: 0 }, { e: "b", ts: 10 }, { e: "c", ts: 200 }], steps, 100), 2);
  assert.equal(funnelLevel([{ e: "b", ts: 0 }, { e: "c", ts: 1 }], steps, 100), 0);
  assert.equal(funnelLevel([{ e: "a", ts: 0 }, { e: "a", ts: 500 }, { e: "b", ts: 510 }], steps, 100), 2);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.75), 4);
  assert.equal(rate("lcp", 2600), "needs-improvement");
});

test("insights rules", () => {
  const k = (v) => ({ visitors: v, pageviews: v * 2, events: v * 3, sessions: v, bounce_rate: 0, avg_session_secs: 0 });
  const seo = { sessions: 0, previous: 0, channels: [], landing: [] };
  const vitals = { overall: [], by_device: [], by_page: [] };
  const none = buildInsights({ days: 30, cur: { ...k(0), events: 0 }, prev: k(0), seo, vitals });
  assert.equal(none[0].kind, "no_data");
  const up = buildInsights({ days: 30, cur: k(100), prev: k(50), seo, vitals,
    eventsCur: [{ value: "stage_clear", events: 10, users: 5 }], eventsPrev: [{ value: "stage_clear", events: 100, users: 50 }] });
  const kinds = up.map((x) => x.kind);
  assert.ok(kinds.includes("traffic_up"));
  assert.ok(kinds.includes("event_down"));
  assert.ok(kinds.includes("vitals_missing"));
  assert.ok(kinds.indexOf("event_down") < kinds.indexOf("traffic_up")); // warn before good
});

test("projects and origins", () => {
  const p = parseProjects("1|pk|rk|https://a.com,https://*.pages.dev;2|pk2|rk2|*");
  assert.equal(p.length, 2);
  assert.ok(originAllowed(p[0].origins, "https://x.pages.dev"));
  assert.ok(!originAllowed(p[0].origins, "https://evil.com"));
  assert.ok(originAllowed(p[1].origins, "https://anything.com"));
});

test("PROJECTS survives sloppy pasting", async () => {
  const { parseProjects } = await import("../lib/config.js");
  const got = parseProjects(' "1|pk_a|rk_a|https://a.com, https://b.com|||90 ;\n`2|pk_b|rk_b|*`\n junk ');
  assert.deepEqual(got.map((p) => [p.appId, p.writeKey, p.readKey, p.origins.length, p.retentionDays]),
    [[1, "pk_a", "rk_a", 2, 90], [2, "pk_b", "rk_b", 0, 395]]);
  const { onRequest } = await import("../functions/healthz.js");
  const body = await (await onRequest({ env: { PROJECTS: "1|pk|rk|*" } })).text();
  assert.match(body, /MISSING/);
  assert.match(body, /#1/);
  assert.doesNotMatch(body, /pk|rk/);
});
