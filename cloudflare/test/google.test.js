import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.js";
import { handleApi } from "../lib/api.js";
import { cleanProperty, cleanSite, forgetToken, serviceAccount } from "../lib/google.js";

// A real RSA key, so the JWT signing path runs as on Cloudflare.
async function saJSON() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: "service_account", client_email: "gstats@demo.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" });
}

const DAY = 86400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// fakeGoogle answers the token, Search Console and GA4 endpoints from canned
// rows and records each call.
function fakeGoogle(now, opts = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    url = String(url);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body.startsWith("{") ? init.body : "{}") : {};
    calls.push({ url, body });
    const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      assert.match(String(init.body), /assertion=[\w-]+\.[\w-]+\.[\w-]+/);
      return ok({ access_token: "ya29.test", expires_in: 3600 });
    }
    if (url.includes("searchconsole.googleapis.com")) {
      if (opts.gscDenied) return new Response(JSON.stringify({ error: { message: "User does not have sufficient permission" } }), { status: 403 });
      const rows = [];
      for (let t = Date.parse(body.startDate); t <= Date.parse(body.endDate); t += DAY) {
        const d = day(t);
        if (body.dimensions.length === 1) rows.push({ keys: [d], clicks: 10, impressions: 200, position: 8 });
        else {
          rows.push({ keys: [d, "tavern knights", "https://tavern-knights.pages.dev/"], clicks: 6, impressions: 40, position: 2 });
          rows.push({ keys: [d, "เกมการ์ดออนไลน์", "https://tavern-knights.pages.dev/guide/"], clicks: 1, impressions: 60, position: 9 });
        }
      }
      return ok({ rows });
    }
    if (url.includes("analyticsdata.googleapis.com")) {
      assert.match(url, /properties\/123456789:runReport$/);
      const rows = [];
      for (let t = Date.parse(body.dateRanges[0].startDate); t <= now; t += DAY) {
        const d = day(t).replace(/-/g, "");
        rows.push({ dimensionValues: [{ value: d }, { value: "Organic Search" }], metricValues: [{ value: "5" }, { value: "4" }, { value: "3" }, { value: "1" }] });
        rows.push({ dimensionValues: [{ value: d }, { value: "Direct" }], metricValues: [{ value: "2" }, { value: "2" }, { value: "1" }, { value: "0" }] });
      }
      return ok({ rows });
    }
    throw new Error("unexpected fetch " + url);
  };
  return { calls, fetchFn };
}

async function call(e, method, path, { key = "rk_test", admin, body, now } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers["X-Admin-Key"] = admin;
  else headers["X-Read-Key"] = key;
  const res = await handleApi(new Request("https://a.pages.dev/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), e, now);
  const j = await res.json();
  return { status: res.status, data: j.data, error: j.error };
}

test("cleanSite and cleanProperty", () => {
  assert.equal(cleanSite("sc-domain:Example.com"), "sc-domain:example.com");
  assert.equal(cleanSite("tavern-knights.pages.dev"), "https://tavern-knights.pages.dev/");
  assert.equal(cleanSite("https://rochano.github.io/chess"), "https://rochano.github.io/chess/");
  assert.throws(() => cleanSite("sc-domain:nope"));
  assert.equal(cleanProperty("properties/123456789"), "123456789");
  assert.throws(() => cleanProperty("G-ABC123"));
  assert.equal(serviceAccount({}), null);
  assert.ok(serviceAccount({ GOOGLE_SERVICE_ACCOUNT: "{bad" }).error);
});

test("link, sync, backfill and report", async (t) => {
  const now = Date.parse("2026-11-15T09:00:00Z");
  const g = fakeGoogle(now);
  t.mock.method(globalThis, "fetch", g.fetchFn);
  forgetToken();
  const e = { DB: fakeD1(), PROJECTS: "1|pk_test|rk_test|*|||395|Tavern Knights", TZ_OFFSET_MINUTES: "420", ADMIN_KEY: "admin_secret", GOOGLE_SERVICE_ACCOUNT: await saJSON() };

  // Not linked yet: the dashboard shows the service account to add.
  let r = await call(e, "GET", "google?days=30", { now });
  assert.equal(r.status, 200);
  assert.equal(r.data.linked, false);
  assert.equal(r.data.service_account, "gstats@demo.iam.gserviceaccount.com");

  // Only the admin may link.
  r = await call(e, "PUT", "admin/google/1", { admin: "wrong", body: {}, now });
  assert.equal(r.status, 401);
  r = await call(e, "PUT", "admin/google/1", { admin: "admin_secret", body: { gsc_site: "G-XYZ", ga4_property: "" }, now });
  assert.equal(r.status, 400);
  r = await call(e, "PUT", "admin/google/1", { admin: "admin_secret", body: { gsc_site: "https://tavern-knights.pages.dev", ga4_property: "123456789" }, now });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.data.gsc_site, "https://tavern-knights.pages.dev/");
  assert.equal(r.data.gsc_error, "");
  assert.equal(r.data.ga4_error, "");
  assert.equal(r.data.backfilling, true); // 90 days of page x query rows come in chunks

  const totals = e.DB.raw.prepare("SELECT COUNT(*) AS n FROM gsc_totals").get().n;
  assert.equal(totals, 180);

  // The dashboard keeps calling sync until the backfill is done.
  let rounds = 0;
  for (let st = r.data; st.backfilling; rounds++) {
    assert.ok(rounds < 15, "backfill does not finish");
    st = (await call(e, "POST", "google/sync", { now: now + rounds * 1000 + 1000 })).data;
  }
  assert.ok(rounds >= 7 && rounds <= 10, `backfill took ${rounds} rounds`);
  const days = e.DB.raw.prepare("SELECT COUNT(DISTINCT day) AS n FROM gsc_rows").get().n;
  assert.equal(days, 90);

  // Done: a manual sync right after does not call Google again.
  const before = g.calls.length;
  r = await call(e, "POST", "google/sync", { now: now + 60_000 });
  assert.equal(g.calls.length, before);

  r = await call(e, "GET", "google?days=7", { now: now + 60_000 });
  assert.equal(r.status, 200);
  const s = r.data.gsc;
  assert.equal(s.trend.length, 7);
  // Bangkok's today (Nov 15) is in range; Google has rows up to the UTC day.
  assert.equal(s.totals.clicks, 70);
  assert.equal(s.totals.impressions, 1400);
  assert.equal(s.previous.clicks, 70);
  assert.equal(Math.round(s.totals.position), 8);
  assert.equal(s.queries[0].query, "tavern knights");
  assert.equal(s.queries[0].clicks, 42);
  assert.equal(s.queries[0].previous, 42);
  assert.equal(s.opportunities.length, 1);
  assert.equal(s.opportunities[0].query, "เกมการ์ดออนไลน์");
  assert.equal(s.pages[0].path, "/");
  assert.equal(s.pages[1].path, "/guide/");
  const ga = r.data.ga4;
  assert.equal(ga.channels[0].channel, "Organic Search");
  assert.equal(ga.channels[0].sessions, 35);
  assert.equal(ga.sessions, 49);
  assert.equal(ga.key_events, 7);

  // Hours later, opening the tab syncs again in the background.
  const later = now + 7 * 3600_000;
  const pending = [];
  const n0 = g.calls.length;
  const res = await handleApi(new Request("https://a.pages.dev/api/google?days=7", { headers: { "X-Read-Key": "rk_test" } }), e, later, (p) => pending.push(p));
  assert.equal(res.status, 200);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.ok(g.calls.length > n0);

  // The admin page lists every project with its status.
  r = await call(e, "GET", "admin/google", { admin: "admin_secret", now: later });
  assert.equal(r.data.projects.length, 1);
  assert.equal(r.data.projects[0].linked, true);

  // Changing the site clears the old site's rows.
  r = await call(e, "PUT", "admin/google/1", { admin: "admin_secret", body: { gsc_site: "", ga4_property: "123456789" }, now: later + 10 });
  assert.equal(r.status, 200);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM gsc_rows").get().n, 0);
});

test("permission errors are saved and shown", async (t) => {
  const now = Date.parse("2026-11-15T09:00:00Z");
  t.mock.method(globalThis, "fetch", fakeGoogle(now, { gscDenied: true }).fetchFn);
  forgetToken();
  const e = { DB: fakeD1(), PROJECTS: "1|pk_test|rk_test|*", ADMIN_KEY: "admin_secret", GOOGLE_SERVICE_ACCOUNT: Buffer.from(await saJSON()).toString("base64") };
  const r = await call(e, "PUT", "admin/google/1", { admin: "admin_secret", body: { gsc_site: "sc-domain:example.com" }, now });
  assert.equal(r.status, 200);
  assert.match(r.data.gsc_error, /สิทธิ์/);
  assert.equal(r.data.synced_at, null); // a failed first sync starts over next time
  assert.equal(r.data.backfilling, false); // no retry loop while it fails
});
