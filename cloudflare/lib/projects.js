// Projects come from two places: the PROJECTS variable (read-only here) and
// the projects table in D1, which the admin page adds to and edits. A short
// per-isolate cache keeps lookups off D1 on every event.
import { projectsFrom, sameKey } from "./config.js";

export const PROJECTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
    app_id         INTEGER PRIMARY KEY,
    name           TEXT    NOT NULL DEFAULT '',
    write_key      TEXT    NOT NULL UNIQUE,
    read_key       TEXT    NOT NULL UNIQUE,
    origins        TEXT    NOT NULL DEFAULT '',
    retention_days INTEGER NOT NULL DEFAULT 395,
    created_at     INTEGER NOT NULL,
    owner_id       INTEGER NOT NULL DEFAULT 0 -- 0 = added by the admin
  )`,
  `CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id)`,
];

const TTL_MS = 30_000;
let cached = null; // { db, exp, list }

const ready = new WeakSet();
async function ensure(db) {
  if (ready.has(db)) return;
  await db.batch(PROJECTS_SCHEMA.map((s) => db.prepare(s)));
  ready.add(db);
}

function fromRow(r) {
  return {
    appId: r.app_id, name: r.name, writeKey: r.write_key, readKey: r.read_key,
    origins: r.origins ? r.origins.split(",").filter(Boolean) : [],
    retentionDays: r.retention_days, source: "db", ownerId: r.owner_id || 0,
  };
}

export async function dbProjects(db) {
  if (!db) return [];
  await ensure(db);
  const res = await db.prepare("SELECT * FROM projects ORDER BY app_id").all();
  return (res.results || []).map(fromRow);
}

// allProjects merges both sources. An id in PROJECTS wins over the same id in D1.
export async function allProjects(env, now = Date.now()) {
  const fromEnv = projectsFrom(env).map((p) => ({ ...p, source: "env" }));
  if (!env.DB) return fromEnv;
  if (!cached || cached.db !== env.DB || cached.exp <= now) {
    let rows = [];
    try {
      rows = await dbProjects(env.DB);
    } catch (e) {
      console.error("projects lookup failed", e && e.message);
      if (cached && cached.db === env.DB) rows = cached.rows; // keep serving the last good list
    }
    cached = { db: env.DB, exp: now + TTL_MS, rows };
  }
  const ids = new Set(fromEnv.map((p) => p.appId));
  return [...fromEnv, ...cached.rows.filter((p) => !ids.has(p.appId))];
}

export function forgetProjects() {
  cached = null;
}

export async function byWriteKey(env, key) {
  return (await allProjects(env)).find((p) => sameKey(p.writeKey, key));
}

export async function byReadKey(env, key) {
  return (await allProjects(env)).find((p) => p.readKey && sameKey(p.readKey, key));
}

// ---- Admin ------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function randomKey(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]; // 248 = 62*4, tiny bias is fine for keys
  return prefix + s;
}

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// cleanOrigins accepts "*", blank, or a comma/space/newline list of
// https:// or http:// origins (wildcard subdomains allowed).
export function cleanOrigins(input) {
  const list = String(input || "").split(/[\s,]+/).map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!list.length || list.includes("*")) return "";
  for (const o of list) {
    if (!/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new AdminError(400, `เว็บไม่ถูกรูปแบบ: ${o} (ใช้แบบ https://example.com)`);
  }
  return list.join(",");
}

function cleanName(input) {
  const name = String(input || "").trim().replace(/\s+/g, " ");
  if (!name) throw new AdminError(400, "ใส่ชื่อโปรเจกต์ก่อน");
  if (name.length > 80) throw new AdminError(400, "ชื่อยาวเกิน 80 ตัวอักษร");
  return name;
}

export const MAX_PROJECTS_PER_ACCOUNT = 10;

export async function ownedProjects(db, ownerId) {
  await ensure(db);
  const res = await db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY app_id").bind(ownerId).all();
  return (res.results || []).map(fromRow);
}

// createProject adds a project. ownerId 0 means the admin added it.
export async function createProject(env, body, now = Date.now(), ownerId = 0) {
  const db = env.DB;
  await ensure(db);
  const name = cleanName(body.name);
  const origins = cleanOrigins(body.origins);
  if (ownerId) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?").bind(ownerId).first();
    if ((n?.n || 0) >= MAX_PROJECTS_PER_ACCOUNT) throw new AdminError(403, `บัญชีหนึ่งสร้างได้สูงสุด ${MAX_PROJECTS_PER_ACCOUNT} โปรเจกต์`);
  }
  const envIds = projectsFrom(env).map((p) => p.appId);
  let p;
  for (let attempt = 0; ; attempt++) {
    const row = await db.prepare("SELECT COALESCE(MAX(app_id), 0) AS m FROM projects").first();
    const appId = Math.max(row?.m || 0, ...envIds, 0) + 1;
    p = { app_id: appId, name, write_key: randomKey("pk_"), read_key: randomKey("rk_"), origins, retention_days: 395, created_at: now, owner_id: ownerId };
    try {
      await db.prepare(
        "INSERT INTO projects (app_id, name, write_key, read_key, origins, retention_days, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(p.app_id, p.name, p.write_key, p.read_key, p.origins, p.retention_days, p.created_at, p.owner_id).run();
      break;
    } catch (e) {
      if (attempt >= 2) throw e; // two sign-ups took the same id at once: try the next one
    }
  }
  forgetProjects();
  return fromRow(p);
}

// updateProject edits a D1 project. With ownerId set, only that owner's project.
export async function updateProject(env, appId, body, ownerId = null) {
  const db = env.DB;
  await ensure(db);
  if (ownerId === null && projectsFrom(env).some((p) => p.appId === appId)) throw new AdminError(409, "โปรเจกต์นี้ตั้งไว้ใน PROJECTS แก้ได้ที่หน้า Cloudflare เท่านั้น");
  const cur = await db.prepare("SELECT * FROM projects WHERE app_id = ?").bind(appId).first();
  if (!cur || (ownerId !== null && cur.owner_id !== ownerId)) throw new AdminError(404, "ไม่พบโปรเจกต์");
  const name = body.name !== undefined ? cleanName(body.name) : cur.name;
  const origins = body.origins !== undefined ? cleanOrigins(body.origins) : cur.origins;
  const readKey = body.new_read_key ? randomKey("rk_") : cur.read_key;
  await db.prepare("UPDATE projects SET name = ?, origins = ?, read_key = ? WHERE app_id = ?").bind(name, origins, readKey, appId).run();
  forgetProjects();
  return fromRow({ ...cur, name, origins, read_key: readKey });
}
