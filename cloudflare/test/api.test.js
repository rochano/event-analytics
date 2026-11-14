import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.js";
import { handleApi, handleIngest } from "../lib/api.js";

const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const UA_DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

function env() {
  return { DB: fakeD1(), PROJECTS: "1|pk_test|rk_test|https://game.example.com,https://*.pages.dev|||90| Tavern  Knights ;2|pk_two|rk_two|*", TZ_OFFSET_MINUTES: "420" };
}

function post(e, body, headers = {}) {
  return handleIngest(new Request("https://a.pages.dev/e", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "text/plain", Origin: "https://game.example.com", "User-Agent": UA_DESK, ...headers },
  }), e);
}

async function get(e, path, key = "rk_test") {
  const res = await handleApi(new Request("https://a.pages.dev/api/" + path, { headers: { "X-Read-Key": key } }), e, Date.now() + 1); // ranges end before "now": count rows written this same ms
  const body = await res.json();
  return { status: res.status, body, data: body.data };
}

const count = (e) => {
  try { return e.DB.raw.prepare("SELECT COUNT(*) AS n FROM events").get().n; } catch { return 0; } // no table yet
};

const iso = (ms) => new Date(ms).toISOString();

// Three visits today: from Google (2 pages + a game event), ChatGPT (bounce),
// direct (bounce), plus web vitals and a funnel.
function sessions(now) {
  const t = (s) => iso(now - 3600_000 + s * 1000);
  const pv = (id, sid, s, path, ref, ua) => ({
    event: "$pageview", distinct_id: id, session_id: sid, timestamp: t(s),
    properties: { $current_url: "https://game.example.com" + path, $pathname: path, $referrer: ref, $user_agent: ua },
  });
  return [
    pv("u1", "s1", 0, "/about.html", "https://www.google.com/", UA_MOBILE),
    pv("u1", "s1", 30, "/", "https://game.example.com/about.html", UA_MOBILE),
    { event: "stage_start", distinct_id: "u1", session_id: "s1", timestamp: t(40), properties: { stage: 1 } },
    { event: "stage_clear", distinct_id: "u1", session_id: "s1", timestamp: t(100), properties: { stage: 1 } },
    pv("u2", "s2", 10, "/about.html", "https://chatgpt.com/", UA_DESK),
    { event: "stage_start", distinct_id: "u3", session_id: "s3", timestamp: t(5) },
    pv("u3", "s3", 0, "/", "", UA_DESK),
    { event: "$web_vitals", distinct_id: "u1", session_id: "s1", timestamp: t(31),
      properties: { $pathname: "/about.html", lcp: 1800, inp: 120, cls: 0.02, fcp: 900, ttfb: 300, $user_agent: UA_MOBILE } },
  ];
}

test("ingest then every dashboard route", async () => {
  const e = env();
  const now = Date.now();
  let res = await post(e, { api_key: "pk_test", sent_at: iso(Date.now()), batch: sessions(now) });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://game.example.com");
  assert.equal(count(e), 8);

  const ov = await get(e, "overview?days=7");
  assert.equal(ov.status, 200);
  assert.equal(ov.data.current.visitors, 3);
  assert.equal(ov.data.current.pageviews, 4);
  assert.equal(ov.data.current.events, 8);
  assert.equal(ov.data.current.sessions, 3);
  assert.ok(Math.abs(ov.data.current.bounce_rate - 1 / 3) < 1e-9); // s3 has one page but played, so only s2 bounced
  assert.equal(ov.data.active_now >= 0, true);

  const tr = await get(e, "trend?days=7");
  assert.equal(tr.data.length, 7);
  assert.equal(tr.data.reduce((a, p) => a + p.events, 0), 8);
  const hr = await get(e, "trend?days=1&interval=hour&event=%24pageview");
  assert.equal(hr.data.reduce((a, p) => a + p.events, 0), 4);

  const pages = await get(e, "breakdown?dim=pathname&event=%24pageview&limit=8&days=7");
  assert.deepEqual(pages.data[0], { value: "/about.html", events: 2, users: 2 });
  const dev = await get(e, "breakdown?dim=device_type&days=7");
  assert.ok(dev.data.find((r) => r.value === "Mobile"));
  assert.equal((await get(e, "breakdown?dim=nope")).status, 400);

  const evs = await get(e, "events?days=7");
  assert.ok(evs.data.find((r) => r.value === "stage_start" && r.users === 2));
  const ord = Object.fromEntries(evs.data.map((r) => [r.value, r.order]));
  assert.equal(ord.stage_start, 2.5); // 3rd for u1, 2nd for u3
  assert.equal(ord.stage_clear, 4);
  assert.ok(ord.$pageview < ord.stage_start);

  const fn = await get(e, "funnel?days=7&steps=stage_start,stage_clear&window=3600");
  assert.deepEqual(fn.data, [{ event: "stage_start", users: 2 }, { event: "stage_clear", users: 1 }]);
  assert.equal((await get(e, "funnel?steps=a")).status, 400);

  const ret = await get(e, "retention?weeks=4");
  assert.equal(ret.data.length, 4);
  assert.equal(ret.data[3].size, 3);
  assert.equal(ret.data[3].users.length, 1);

  const lv = await get(e, "live?limit=5");
  assert.equal(lv.data.events.length, 5);
  assert.ok(lv.data.events[0].timestamp.endsWith("Z"));

  const seo = await get(e, "seo?days=7");
  const by = Object.fromEntries(seo.data.channels.map((c) => [c.channel, c]));
  assert.equal(seo.data.sessions, 3);
  assert.equal(by["Organic Search"].sessions, 1);
  assert.equal(by.AI.sessions, 1);
  assert.equal(by.Direct.sessions, 1);
  assert.equal(by["Organic Search"].bounce_rate, 0); // two pages and a game event
  assert.equal(by.AI.bounce_rate, 1);
  assert.equal(by.Direct.bounce_rate, 0); // stage_start is a custom event
  const about = seo.data.landing.find((l) => l.page === "/about.html");
  assert.deepEqual([about.sessions, about.search, about.ai], [2, 1, 1]);
  assert.equal(seo.data.landing.find((l) => l.page === "/").sessions, 1); // first-touch landing

  const vit = await get(e, "vitals?days=7");
  assert.equal(vit.data.overall.find((v) => v.metric === "lcp").p75, 1800);
  assert.equal(vit.data.by_device[0].key, "Mobile");
  assert.equal(vit.data.by_page[0].key, "/about.html");

  const ins = await get(e, "insights?days=7");
  assert.ok(Array.isArray(ins.data));
  assert.equal(ins.data[0].kind, "low_traffic");

  const cfg = await get(e, "config");
  assert.deepEqual(cfg.body, { app_id: 1, name: "Tavern  Knights", write_key: "pk_test", collector_url: "https://a.pages.dev", timezone: "UTC+07:00" });

  // Second call is served from cache.
  const again = await handleApi(new Request("https://a.pages.dev/api/overview?days=7", { headers: { "X-Read-Key": "rk_test" } }), e);
  assert.equal(again.headers.get("X-Cache"), "hit");
});

test("auth, tenancy and origin rules", async () => {
  const e = env();
  assert.equal((await post(e, [{ event: "a", distinct_id: "u" }], { "X-Api-Key": "nope" })).status, 401);
  assert.equal((await get(e, "overview", "nope")).status, 401);
  assert.equal((await get(e, "overview", "")).status, 401);

  // Wrong origin: answered 204, nothing stored.
  let res = await post(e, [{ event: "a", distinct_id: "u" }], { "X-Api-Key": "pk_test", Origin: "https://evil.com" });
  assert.equal(res.status, 204);
  assert.equal(count(e), 0);

  // The dashboard's own origin is always allowed (test-event button).
  res = await post(e, [{ event: "t", distinct_id: "u" }], { "X-Api-Key": "pk_test", Origin: "https://a.pages.dev" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://a.pages.dev");
  assert.equal(count(e), 1);

  // Wildcard origin and key in the query string.
  res = await handleIngest(new Request("https://a.pages.dev/e?k=pk_test", {
    method: "POST", body: '[{"event":"a","distinct_id":"u"},{"event":"","distinct_id":"bad"}]',
    headers: { Origin: "https://preview.pages.dev" },
  }), e);
  assert.equal(res.status, 204);
  assert.equal(count(e), 2); // invalid one dropped

  // Project 2 cannot see project 1's rows.
  await post(e, [{ event: "b", distinct_id: "v" }], { "X-Api-Key": "pk_two", Origin: "https://other.com" });
  assert.equal((await get(e, "overview?days=1", "rk_two")).data.current.events, 1);
  assert.equal((await get(e, "overview?days=1", "rk_test")).data.current.events, 2);

  assert.equal((await post(e, "not json", { "X-Api-Key": "pk_test" })).status, 400);
  assert.equal((await post(e, [], { "X-Api-Key": "pk_test" })).status, 400);
  const pre = await handleIngest(new Request("https://a.pages.dev/e", { method: "OPTIONS", headers: { Origin: "https://x.com" } }), e);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "https://x.com");
});

test("gzip body", async () => {
  const e = env();
  const gz = new Blob([JSON.stringify([{ event: "a", distinct_id: "u" }])]).stream().pipeThrough(new CompressionStream("gzip"));
  const res = await handleIngest(new Request("https://a.pages.dev/e", {
    method: "POST", body: await new Response(gz).arrayBuffer(), headers: { "X-Api-Key": "pk_test", "Content-Encoding": "gzip" },
  }), e);
  assert.equal(res.status, 204);
  assert.equal(count(e), 1);
});
