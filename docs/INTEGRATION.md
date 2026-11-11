# Integration Guide: Sending Events (Web, Mobile, Games)

This guide is the contract for any app or game that plugs into the analytics platform.
You can send **any event name and any properties you want**. No schema has to be registered first.
Follow the rules below so dashboards, funnels and retention work correctly.

---

## 1. What you need before you start

| Item | Where it comes from | Example |
| --- | --- | --- |
| Project key (public, write-only) | `PROJECTS` setting of the collector; shown in the dashboard's Setup tab | `pk_demo` |
| Ingest URL | Your collector's public address | `https://ingest.example.com/e` |
| A stable player/user id | Your game or app | Account id, or a generated device UUID before login |

The project key is safe to embed in a game client: it can only **send** events, never read data.

---

## 2. Event format

Send a JSON array of events with `POST /e` (max 100 events or 512 KB gzipped per request).

```json
[
  {
    "event": "level_complete",
    "distinct_id": "player_102938",
    "timestamp": "2026-11-11T15:40:12.345Z",
    "event_uuid": "01933c5e-7b2a-7c41-9f0e-2b8d4a1c9e77",
    "session_id": "s_7f2c91",
    "properties": {
      "level_id": "world1_stage3",
      "duration_sec": 142,
      "stars": 3,
      "deaths": 1,
      "platform": "android",
      "app_version": "1.4.2"
    }
  }
]
```

### Required fields

| Field | Type | Rule |
| --- | --- | --- |
| `event` | string | Event name, `snake_case`, max 255 chars. See naming rules below |
| `distinct_id` | string | Who did it. Same player = same id on every event and every device after login |

### Recommended fields

| Field | Type | Why |
| --- | --- | --- |
| `timestamp` | ISO 8601 UTC | When it happened on the device. Needed for offline play; server corrects clock skew |
| `event_uuid` | UUIDv7 string | Prevents duplicates when the SDK retries. Generate once per event |
| `session_id` | string | Groups a play session. Start a new one after 30 min idle or app relaunch |
| `properties` | object | Anything you want. Max 200 keys, 32 KB per event |

Events older than 7 days or more than 1 hour in the future are rejected to the error queue.

---

## 3. Naming rules

- Event names: `snake_case`, past-tense or noun-verb, **stable forever** (renaming splits your charts): `level_start`, `level_complete`, `item_purchased`.
- Names starting with `$` are reserved for the platform (`$pageview`, `$identify`, `$session_start`).
- Property keys: `^[a-zA-Z0-9_.\-]{1,128}$`. Keep one type per key (do not send `stars` as a number in one event and a string in another).
- Put variable data in properties, not in the event name: `level_complete` + `{"level_id": "w1_s3"}`, never `level_complete_w1_s3`.
- Money: send `revenue` as a number in major units plus `currency` (ISO 4217), e.g. `{"revenue": 99.0, "currency": "THB"}`.

---

## 4. Identity: anonymous to logged-in

1. Before login, use a random device id (UUID stored on the device) as `distinct_id`.
2. When the player logs in, send one `$identify` event to link the device id to the account id:

```json
{ "event": "$identify", "distinct_id": "player_102938",
  "properties": { "$anon_distinct_id": "dev_5b1e2c...", "$set": { "level": 12, "country": "TH" } } }
```

3. From then on use the account id. The platform merges the history so funnels and retention count one person.
4. Use `$set` / `$set_once` to store player traits (VIP tier, first install date) on the person profile instead of repeating them on every event.

> MVP note: `$identify` events are stored, but merging the anonymous and logged-in histories into one person runs in the enricher, which is not built yet. Until then each `distinct_id` counts as its own person.

---

## 5. Recommended events for games

You can send any events you like. This starter set powers the default game dashboards:

| Event | When | Key properties |
| --- | --- | --- |
| `game_launched` | App opens | `app_version`, `platform`, `device_model` |
| `tutorial_step` | Each tutorial step | `step`, `step_name` |
| `tutorial_complete` | Tutorial finished | `duration_sec` |
| `level_start` | Level begins | `level_id`, `attempt` |
| `level_complete` | Level cleared | `level_id`, `duration_sec`, `score`, `stars` |
| `level_fail` | Level failed or quit | `level_id`, `reason`, `progress_pct` |
| `item_purchased` | Real-money purchase | `sku`, `revenue`, `currency`, `store` |
| `currency_earned` / `currency_spent` | Soft currency changes | `currency_name`, `amount`, `source` / `sink` |
| `ad_watched` | Rewarded or interstitial ad | `ad_type`, `placement`, `reward` |
| `matchmaking_complete` | Multiplayer match found | `mode`, `wait_sec`, `party_size` |

These give you out of the box: DAU/MAU, day-1/7/30 retention, tutorial funnel, level difficulty (fail rate per `level_id`), revenue per user, and ad engagement.

---

## 6. Sending from a game

Send events from a background queue, never on the game loop's main thread.

- **Batch:** flush every 10–30 s, at 50 events, and when the app goes to background.
- **Offline:** store unsent events on disk (SQLite or a file) and retry with exponential backoff; respect `Retry-After` on HTTP 429.
- **Compression:** gzip the body when it is over 1 KB (`Content-Encoding: gzip`).
- **Response:** `204` = accepted. `400` = bad payload (do not retry). `429` / `5xx` = retry later, keep the events.

Minimal Unity (C#) example:

```csharp
// Queue events in memory/disk elsewhere; this sends one batch.
IEnumerator SendBatch(string jsonArray) {
    var req = new UnityWebRequest("https://ingest.example.com/e", "POST");
    req.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(jsonArray));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("Content-Type", "application/json");
    req.SetRequestHeader("X-Api-Key", "pk_live_8f3a...");
    yield return req.SendWebRequest();
    if (req.responseCode == 204) { /* drop batch from queue */ }
    else if (req.responseCode == 429 || req.responseCode >= 500) { /* keep, retry with backoff */ }
    else { /* 4xx: log and drop */ }
}
```

The same HTTP API works from Unreal, Godot, Cocos, native iOS/Android, or a game server.
SDKs: JavaScript is in `sdk/js/analytics.js` (`window.pulse`). iOS, Android, Unity and server SDKs are planned; until then use the HTTP API above.

---

## 7. Privacy rules (PDPA / GDPR)

- Do **not** put emails, phone numbers, real names, national ID or payment card data in event properties. Use the account id.
- Do not send chat messages or free-text input.
- If a player deletes their account, their data must be erased. The erasure API (`DELETE /persons/{distinct_id}`) is planned (docs/architecture.md section 6); until it ships, run a lightweight `DELETE FROM analytics.events WHERE app_id = ? AND distinct_id = ?` in ClickHouse.
- Respect consent: if the player opts out, stop sending events (`optOut()` in the SDKs).

---

## 8. Checklist before going live

- [ ] Project key and ingest URL configured per environment (dev / prod use different projects)
- [ ] `distinct_id` is stable and `$identify` is sent on login
- [ ] Event names follow `snake_case` and are documented in your team's tracking plan
- [ ] Events are batched, persisted offline and retried
- [ ] No PII in properties
- [ ] Verified in the dashboard's Live events tab that events arrive with the expected properties
