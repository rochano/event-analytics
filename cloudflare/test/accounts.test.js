import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.js";
import { handleApi, handleIngest } from "../lib/api.js";
import { cleanOrigins } from "../lib/projects.js";

const BASE = "https://g.pages.dev";
const env = (extra = {}) => ({ DB: fakeD1(), PROJECTS: "1|pk_env|rk_env|*|||395|Env Game", TZ_OFFSET_MINUTES: "420", ADMIN_KEY: "admin-secret-123", ...extra });

function account(e, method, path, body, cookie = "", headers = {}) {
  return handleApi(new Request(`${BASE}/api/account/${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Origin: BASE, Cookie: cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), e);
}
const admin = (e, method, path, body, key = "admin-secret-123") => handleApi(new Request(`${BASE}/api/admin/${path}`, {
  method, headers: { "X-Admin-Key": key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
}), e);
const ingest = (e, key, n = 1) => handleIngest(new Request(`${BASE}/e`, {
  method: "POST", headers: { "X-Api-Key": key, Origin: "https://mygame.com" },
  body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ event: "play", distinct_id: "u" + i }))),
}), e);
const cookieOf = (res) => (res.headers.get("Set-Cookie") || "").split(";")[0];

test("sign up, create a project, send events, read the dashboard", async () => {
  const e = env({ FREE_QUOTA: "5" });
  let res = await account(e, "POST", "signup", { email: "A@Example.com", password: "short" });
  assert.equal(res.status, 400);
  res = await account(e, "POST", "signup", { email: "A@Example.com", password: "longenough1" });
  assert.equal(res.status, 201);
  const set = res.headers.get("Set-Cookie");
  assert.match(set, /gs_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const c = cookieOf(res);
  assert.equal((await account(e, "POST", "signup", { email: "a@example.com", password: "longenough1" })).status, 409);

  res = await account(e, "POST", "projects", { name: "  My   Game ", origins: "https://mygame.com/" }, c);
  assert.equal(res.status, 201);
  const p = (await res.json()).data;
  assert.equal(p.name, "My Game");
  assert.equal(p.app_id, 2); // after the PROJECTS id
  assert.match(p.write_key, /^pk_[A-Za-z0-9]{24}$/);
  assert.deepEqual(p.origins, ["https://mygame.com"]);

  // Events count against the quota of 5; the batch that crosses it is still stored.
  assert.equal((await ingest(e, p.write_key, 3)).status, 204);
  assert.equal((await ingest(e, p.write_key, 3)).status, 204);
  res = await ingest(e, p.write_key, 1);
  assert.equal(res.status, 402);
  const me = (await (await account(e, "GET", "me", undefined, c)).json()).data;
  assert.equal(me.email, "a@example.com");
  assert.equal(me.usage.used, 6);
  assert.equal(me.usage.quota, 5);
  assert.equal(me.projects.length, 1);

  // PROJECTS projects have no quota.
  assert.equal((await ingest(e, "pk_env", 3)).status, 204);

  const ov = await handleApi(new Request(`${BASE}/api/overview?days=1`, { headers: { "X-Read-Key": p.read_key } }), e, Date.now() + 1);
  assert.equal((await ov.json()).data.current.events, 6);
  const cfg = await (await handleApi(new Request(`${BASE}/api/config?key=${p.read_key}`), e)).json();
  assert.equal(cfg.name, "My Game");

  // The admin raises the quota; ingest works again.
  const users = (await (await admin(e, "GET", "users")).json()).data.users;
  assert.equal(users[0].email, "a@example.com");
  assert.equal(users[0].used, 6);
  assert.equal(users[0].projects, 1);
  assert.equal((await admin(e, "PATCH", `users/${users[0].id}`, { event_quota: 100000 })).status, 200);
  assert.equal((await ingest(e, p.write_key, 1)).status, 204);

  // Rotate the read key; the old one stops working.
  res = await account(e, "PATCH", `projects/${p.app_id}`, { new_read_key: true }, c);
  const p2 = (await res.json()).data;
  assert.notEqual(p2.read_key, p.read_key);
  assert.equal((await handleApi(new Request(`${BASE}/api/config`, { headers: { "X-Read-Key": p.read_key } }), e)).status, 401);

  // Log out ends the session.
  res = await account(e, "POST", "logout", {}, c);
  assert.match(res.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await account(e, "GET", "me", undefined, c)).status, 401);
});

test("accounts are isolated and protected", async () => {
  const e = env();
  const a = cookieOf(await account(e, "POST", "signup", { email: "a@x.io", password: "password-a" }));
  const b = cookieOf(await account(e, "POST", "signup", { email: "b@x.io", password: "password-b" }));
  const pa = (await (await account(e, "POST", "projects", { name: "A game" }, a)).json()).data;
  assert.equal((await account(e, "PATCH", `projects/${pa.app_id}`, { name: "stolen" }, b)).status, 404);
  assert.equal((await (await account(e, "GET", "me", undefined, b)).json()).data.projects.length, 0);
  assert.equal((await account(e, "PATCH", "projects/1", { name: "x" }, a)).status, 404); // PROJECTS id

  // Wrong password, unknown email, cross-site POST, non-JSON POST, no cookie.
  assert.equal((await account(e, "POST", "login", { email: "a@x.io", password: "nope-nope" })).status, 401);
  assert.equal((await account(e, "POST", "login", { email: "zz@x.io", password: "nope-nope" })).status, 401);
  assert.equal((await account(e, "POST", "login", { email: "a@x.io", password: "password-a" })).status, 200);
  assert.equal((await account(e, "POST", "projects", { name: "x" }, a, { Origin: "https://evil.com" })).status, 403);
  assert.equal((await handleApi(new Request(`${BASE}/api/account/projects`, { method: "POST", headers: { Cookie: a }, body: "name=x" }), e)).status, 415);
  assert.equal((await account(e, "GET", "me")).status, 401);

  // Sign-up can be closed.
  assert.equal((await account({ ...e, SIGNUP: "off" }, "POST", "signup", { email: "c@x.io", password: "password-c" })).status, 403);

  // Admin: needs the key; sees every project; cannot edit PROJECTS ones.
  assert.equal((await admin(e, "GET", "projects", null, "wrong")).status, 401);
  assert.equal((await admin({ ...e, ADMIN_KEY: "" }, "GET", "projects")).status, 503);
  const list = (await (await admin(e, "GET", "projects")).json()).data;
  assert.deepEqual(list.map((p) => [p.app_id, p.source, p.editable]), [[1, "env", false], [pa.app_id, "db", true]]);
  assert.equal((await admin(e, "PATCH", "projects/1", { name: "x" })).status, 409);
  const added = (await (await admin(e, "POST", "projects", { name: "Admin game", origins: "*" })).json()).data;
  assert.equal(added.app_id, pa.app_id + 1);
  assert.equal((await ingest(e, added.write_key, 2)).status, 204); // no quota for admin projects
  assert.equal((await admin(e, "POST", "projects", { name: "" })).status, 400);
});

test("origins are validated", () => {
  assert.equal(cleanOrigins(""), "");
  assert.equal(cleanOrigins("*"), "");
  assert.equal(cleanOrigins("https://a.com/, https://*.b.dev\nhttp://localhost:8080"), "https://a.com,https://*.b.dev,http://localhost:8080");
  assert.throws(() => cleanOrigins("a.com"));
  assert.throws(() => cleanOrigins("javascript:alert(1)"));
});
