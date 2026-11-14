// Customer accounts: sign up with email and password, then manage your own
// projects. Passwords are PBKDF2-SHA256 hashed; sessions are random tokens in
// an HttpOnly cookie, stored hashed in D1.
import { tzOffset } from "./config.js";
import { AdminError, createProject, ownedProjects, updateProject } from "./projects.js";
import { ensureUsage, freeQuota, monthOf, usageOf } from "./usage.js";

export const ACCOUNTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL UNIQUE,
    pw_salt     TEXT    NOT NULL,
    pw_hash     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    event_quota INTEGER NOT NULL DEFAULT 0 -- events a month; the admin can raise it
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  )`,
];

const COOKIE = "gs_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime allows at most 100,000
const enc = new TextEncoder();

const ready = new WeakSet();
async function ensure(db) {
  if (ready.has(db)) return;
  await db.batch(ACCOUNTS_SCHEMA.map((s) => db.prepare(s)));
  await ensureUsage(db);
  ready.add(db);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256));
}

function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function cleanEmail(v) {
  const email = String(v || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminError(400, "อีเมลไม่ถูกต้อง");
  return email;
}

function checkPassword(v) {
  const pw = String(v || "");
  if (pw.length < 8) throw new AdminError(400, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว");
  if (pw.length > 200) throw new AdminError(400, "รหัสผ่านยาวเกินไป");
  return pw;
}

// A small per-isolate limiter for sign-up and login attempts per IP.
const attempts = new Map();
function limit(ip, now, max = 10, windowMs = 10 * 60_000) {
  if (attempts.size > 10_000) attempts.clear();
  const a = attempts.get(ip);
  if (!a || a.reset <= now) {
    attempts.set(ip, { n: 1, reset: now + windowMs });
    return;
  }
  if (++a.n > max) throw new AdminError(429, "ลองหลายครั้งเกินไป รอสักครู่แล้วลองใหม่");
}

function cookieHeader(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function readCookie(request) {
  const m = /(?:^|;\s*)gs_session=([0-9a-f]{64})/.exec(request.headers.get("Cookie") || "");
  return m ? m[1] : "";
}

async function newSession(db, userId, now) {
  const token = randomHex(32);
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now + SESSION_DAYS * 86400_000).run();
  // Now and then, clear expired sessions.
  if (Math.random() < 0.05) await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return cookieHeader(token, SESSION_DAYS * 86400);
}

async function currentUser(db, request, now) {
  const token = readCookie(request);
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(token), now).first();
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const projectView = (p) => ({
  app_id: p.appId, name: p.name, write_key: p.writeKey, read_key: p.readKey, origins: p.origins,
});

// handleAccount serves /api/account/*.
export async function handleAccount(request, env, sub, now = Date.now()) {
  const db = env.DB;
  if (!db) return json(500, { error: "D1 binding DB is missing" });
  const url = new URL(request.url);
  // Cookie-authenticated writes must come from this site's own pages.
  if (request.method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json(403, { error: "forbidden" });
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return json(415, { error: "send JSON" });
  }
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  try {
    await ensure(db);
    const body = request.method === "GET" ? {} : await request.json().catch(() => ({}));

    if (sub === "signup" && request.method === "POST") {
      if (String(env.SIGNUP || "").toLowerCase() === "off") throw new AdminError(403, "ปิดรับสมัครชั่วคราว");
      limit(ip, now);
      const email = cleanEmail(body.email);
      const pw = checkPassword(body.password);
      const salt = randomHex(16);
      const hash = await hashPassword(pw, salt);
      try {
        await db.prepare("INSERT INTO users (email, pw_salt, pw_hash, created_at, event_quota) VALUES (?, ?, ?, ?, ?)").bind(email, salt, hash, now, freeQuota(env)).run();
      } catch {
        throw new AdminError(409, "อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบ");
      }
      const u = await db.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
      return json(201, { data: { email: u.email } }, { "Set-Cookie": await newSession(db, u.id, now) });
    }

    if (sub === "login" && request.method === "POST") {
      limit(ip, now);
      const email = cleanEmail(body.email);
      const u = await db.prepare("SELECT id, email, pw_salt, pw_hash FROM users WHERE email = ?").bind(email).first();
      // Hash even for unknown emails so timing does not reveal which exist.
      const hash = await hashPassword(String(body.password || ""), u ? u.pw_salt : "00".repeat(16));
      if (!u || !sameHex(hash, u.pw_hash)) throw new AdminError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
      return json(200, { data: { email: u.email } }, { "Set-Cookie": await newSession(db, u.id, now) });
    }

    if (sub === "logout" && request.method === "POST") {
      const token = readCookie(request);
      if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return json(200, { data: null }, { "Set-Cookie": cookieHeader("", 0) });
    }

    const user = await currentUser(db, request, now);
    if (!user) return json(401, { error: "กรุณาเข้าสู่ระบบ" });

    if (sub === "me" && request.method === "GET") {
      const month = monthOf(now, tzOffset(env));
      const usage = await usageOf(db, user.id, month);
      return json(200, { data: { email: user.email, usage: { month, ...usage }, projects: (await ownedProjects(db, user.id)).map(projectView) } });
    }
    if (sub === "projects" && request.method === "POST") {
      return json(201, { data: projectView(await createProject(env, body, now, user.id)) });
    }
    const m = /^projects\/(\d+)$/.exec(sub);
    if (m && request.method === "PATCH") {
      return json(200, { data: projectView(await updateProject(env, Number(m[1]), body, user.id)) });
    }
    return json(404, { error: "not found" });
  } catch (e) {
    if (e instanceof AdminError) return json(e.status, { error: e.message });
    console.error("account failed", e && e.message);
    return json(500, { error: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
  }
}
