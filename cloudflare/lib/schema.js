// D1 (SQLite) schema. Created on the first request, like the Tavern Knights
// ranking API, so there is no migration step. Column names follow the
// ClickHouse events table. Only one secondary index: on D1 every index adds a
// written row per insert, and the free plan allows 100,000 written rows a day
// (so about 50,000 events a day).
export const COLUMNS = [
  "app_id", "ts", "event", "uuid", "distinct_id", "session_id", "url", "pathname", "referrer_domain",
  "utm_source", "utm_medium", "utm_campaign", "country_code", "device_type", "os", "browser", "props",
];

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    app_id          INTEGER NOT NULL,
    ts              INTEGER NOT NULL,
    event           TEXT    NOT NULL,
    uuid            TEXT    NOT NULL DEFAULT '',
    distinct_id     TEXT    NOT NULL,
    session_id      TEXT    NOT NULL DEFAULT '',
    url             TEXT    NOT NULL DEFAULT '',
    pathname        TEXT    NOT NULL DEFAULT '',
    referrer_domain TEXT    NOT NULL DEFAULT '',
    utm_source      TEXT    NOT NULL DEFAULT '',
    utm_medium      TEXT    NOT NULL DEFAULT '',
    utm_campaign    TEXT    NOT NULL DEFAULT '',
    country_code    TEXT    NOT NULL DEFAULT '',
    device_type     TEXT    NOT NULL DEFAULT '',
    os              TEXT    NOT NULL DEFAULT '',
    browser         TEXT    NOT NULL DEFAULT '',
    props           TEXT    NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS events_app_ts ON events (app_id, ts)`,
];

const ready = new WeakSet();

export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  ready.add(db);
}

const insertSQL = `INSERT INTO events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;

// insertRows writes rows in one D1 batch (one transaction).
export async function insertRows(db, appId, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(insertSQL);
  await db.batch(rows.map((r) => stmt.bind(...COLUMNS.map((c) => (c === "app_id" ? appId : r[c])))));
}
