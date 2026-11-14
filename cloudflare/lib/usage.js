// Monthly event quotas for customer accounts. Each accepted batch adds its
// event count to usage(owner_id, month): one extra D1 write per batch, not per
// event. Projects from PROJECTS or added by the admin (owner 0) have no quota.
import { localDay } from "./time.js";

export const USAGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usage (
    owner_id INTEGER NOT NULL,
    month    TEXT    NOT NULL,
    events   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, month)
  )`,
];

export const DEFAULT_FREE_QUOTA = 10_000;

export function freeQuota(env) {
  const n = Number(env.FREE_QUOTA);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FREE_QUOTA;
}

export const monthOf = (ms, off) => localDay(ms, off).slice(0, 7);

const ready = new WeakSet();
export async function ensureUsage(db) {
  if (ready.has(db)) return;
  await db.batch(USAGE_SCHEMA.map((s) => db.prepare(s)));
  ready.add(db);
}

// Per-isolate view of each owner's usage and quota, refreshed every minute.
// Between refreshes, local inserts are added so one busy isolate stops near
// the limit; across isolates the overrun is at most a minute of traffic.
const CACHE_MS = 60_000;
const cache = new Map(); // owner -> { month, used, quota, exp }

export async function usageOf(db, ownerId, month) {
  await ensureUsage(db);
  const r = await db.prepare(
    `SELECT u.event_quota AS quota, COALESCE(g.events, 0) AS used
     FROM users u LEFT JOIN usage g ON g.owner_id = u.id AND g.month = ?
     WHERE u.id = ?`,
  ).bind(month, ownerId).first();
  return { used: r?.used || 0, quota: r?.quota ?? 0 };
}

// overQuota reports whether ownerId has no room left this month.
export async function overQuota(db, ownerId, now, off) {
  if (!ownerId) return false;
  const month = monthOf(now, off);
  let c = cache.get(ownerId);
  if (!c || c.exp <= now || c.month !== month) {
    const u = await usageOf(db, ownerId, month);
    c = { month, used: u.used, quota: u.quota, exp: now + CACHE_MS };
    if (cache.size > 5000) cache.clear();
    cache.set(ownerId, c);
  }
  return c.used >= c.quota;
}

export async function addUsage(db, ownerId, n, now, off) {
  if (!ownerId || !n) return;
  const month = monthOf(now, off);
  await ensureUsage(db);
  await db.prepare(
    "INSERT INTO usage (owner_id, month, events) VALUES (?, ?, ?) ON CONFLICT (owner_id, month) DO UPDATE SET events = events + excluded.events",
  ).bind(ownerId, month, n).run();
  const c = cache.get(ownerId);
  if (c && c.month === month) c.used += n;
}

export function forgetUsage(ownerId) {
  if (ownerId === undefined) cache.clear();
  else cache.delete(ownerId);
}
