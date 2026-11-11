/*!
 * Pulse Analytics JS SDK (MVP) — batching, sendBeacon on page hide,
 * persistent retry queue, UUIDv7 event ids, sessions, auto pageviews.
 *
 *   <script src="https://your-host/sdk/analytics.js"></script>
 *   <script>
 *     pulse.init({ key: "pk_demo", host: "https://ingest.example.com" });
 *     pulse.capture("add_to_cart", { sku: "SNK-X", price: 2490 });
 *     pulse.identify("user_123", { plan: "pro" });
 *   </script>
 */
(function (root) {
  "use strict";

  var STORAGE_QUEUE = "pulse_queue_v1";
  var STORAGE_ID = "pulse_id_v1";
  var STORAGE_SESSION = "pulse_session_v1";
  var STORAGE_OPTOUT = "pulse_optout_v1";
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var MAX_QUEUE = 1000;
  var MAX_BATCH = 50;
  var BEACON_MAX_BYTES = 60000;

  var cfg = null;
  var queue = [];
  var timer = null;
  var sending = false;
  var backoffMs = 0;
  var retryAt = 0;

  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { if (cfg && cfg.debug) console.warn("[pulse]", e); }
    };
  }

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] + 0x100).toString(16).slice(1);
    return s;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }
  // RFC 9562 UUIDv7: time-ordered, so retries dedupe and ids sort by time.
  function uuidv7() {
    var b = randomBytes(16);
    var ms = Date.now();
    for (var i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = hex(b);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function distinctId() {
    var id = load(STORAGE_ID);
    if (!id) { id = "anon_" + uuidv7(); store(STORAGE_ID, id); }
    return id;
  }

  function sessionId() {
    var now = Date.now();
    var raw = load(STORAGE_SESSION);
    var s = raw ? JSON.parse(raw) : null;
    if (!s || now - s.last > SESSION_IDLE_MS) s = { id: "s_" + uuidv7(), last: now };
    s.last = now;
    store(STORAGE_SESSION, JSON.stringify(s));
    return s.id;
  }

  function persist() { store(STORAGE_QUEUE, JSON.stringify(queue.slice(-MAX_QUEUE))); }

  function enqueue(ev) {
    queue.push(ev);
    if (queue.length > MAX_QUEUE) {
      // Drop low-value events first, then the oldest.
      var i = queue.findIndex(function (e) { return e.event === "$pageleave"; });
      queue.splice(i >= 0 ? i : 0, 1);
    }
    persist();
    if (queue.length >= cfg.batchSize) flush();
    else schedule();
  }

  function schedule() {
    if (timer) return;
    var wait = Math.max(cfg.flushIntervalMs, retryAt - Date.now());
    timer = setTimeout(function () { timer = null; flush(); }, wait);
  }

  function endpoint() { return cfg.host.replace(/\/$/, "") + "/e"; }

  function body(batch) {
    return JSON.stringify({ api_key: cfg.key, sent_at: new Date().toISOString(), batch: batch });
  }

  var flush = safe(function () {
    if (sending || !queue.length || !cfg) return;
    if (Date.now() < retryAt) { schedule(); return; }
    var batch = queue.slice(0, Math.min(MAX_BATCH, cfg.batchSize));
    sending = true;
    // text/plain keeps this a CORS "simple request": no preflight round trip.
    fetch(endpoint(), { method: "POST", body: body(batch), headers: { "Content-Type": "text/plain" }, keepalive: true })
      .then(function (res) {
        if (res.status === 204 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
          // Accepted, or rejected for good (bad payload): either way drop it.
          queue.splice(0, batch.length);
          persist();
          backoffMs = 0;
          retryAt = 0;
        } else {
          var ra = parseInt(res.headers.get("Retry-After") || "0", 10) * 1000;
          fail(ra);
        }
      })
      .catch(function () { fail(0); })
      .then(function () {
        sending = false;
        if (queue.length) schedule();
      });
  });

  function fail(retryAfterMs) {
    // Exponential backoff with full jitter, capped at 5 minutes.
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 1000, 5 * 60 * 1000);
    retryAt = Date.now() + Math.max(retryAfterMs, Math.random() * backoffMs);
  }

  // Page is going away: hand everything to sendBeacon, which the browser
  // delivers even after the tab closes.
  var flushOnHide = safe(function () {
    if (!queue.length || !root.navigator || !navigator.sendBeacon) { flush(); return; }
    while (queue.length) {
      var n = Math.min(queue.length, MAX_BATCH);
      var payload = body(queue.slice(0, n));
      while (payload.length > BEACON_MAX_BYTES && n > 1) { n = Math.floor(n / 2); payload = body(queue.slice(0, n)); }
      var ok = navigator.sendBeacon(endpoint(), new Blob([payload], { type: "text/plain" }));
      if (!ok) break; // keep the rest for next visit
      queue.splice(0, n);
    }
    persist();
  });

  function baseProps() {
    var p = { $lib: "web", $lib_version: "0.1.0" };
    if (root.location) {
      p.$current_url = location.href;
      p.$pathname = location.pathname;
      p.$host = location.host;
    }
    if (root.document) {
      p.$referrer = document.referrer || "";
      p.$title = document.title;
    }
    if (root.screen) { p.$screen_width = screen.width; p.$screen_height = screen.height; }
    return p;
  }

  function assign(target, src) {
    if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    return target;
  }

  var api = {
    init: safe(function (options) {
      cfg = assign({ host: "", key: "", batchSize: 20, flushIntervalMs: 5000, autoPageview: true, debug: false }, options);
      if (!cfg.key || !cfg.host) throw new Error("pulse.init needs key and host");
      try { queue = JSON.parse(load(STORAGE_QUEUE) || "[]"); } catch (e) { queue = []; }
      if (root.document) {
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushOnHide(); });
        root.addEventListener("pagehide", flushOnHide);
        root.addEventListener("online", function () { retryAt = 0; flush(); });
      }
      if (cfg.autoPageview) {
        api.page();
        // Single-page apps: track history navigation.
        if (root.history && history.pushState) {
          var push = history.pushState;
          history.pushState = function () { push.apply(this, arguments); setTimeout(api.page, 0); };
          root.addEventListener("popstate", function () { api.page(); });
        }
      }
      if (queue.length) schedule();
    }),

    capture: safe(function (event, properties) {
      if (!cfg || load(STORAGE_OPTOUT) === "1") return;
      if (typeof event !== "string" || !event) throw new Error("event name required");
      enqueue({
        event: event,
        distinct_id: distinctId(),
        timestamp: new Date().toISOString(),
        event_uuid: uuidv7(),
        session_id: sessionId(),
        properties: assign(baseProps(), properties)
      });
    }),

    page: safe(function (properties) { api.capture("$pageview", properties); }),

    // Link the anonymous history to a known user id.
    identify: safe(function (userId, traits) {
      if (!userId) return;
      var anon = distinctId();
      if (anon !== String(userId)) store(STORAGE_ID, String(userId));
      api.capture("$identify", { $anon_distinct_id: anon, $set: traits || {} });
    }),

    reset: safe(function () {
      store(STORAGE_ID, "anon_" + uuidv7());
      store(STORAGE_SESSION, "");
    }),

    optOut: safe(function () { store(STORAGE_OPTOUT, "1"); queue = []; persist(); }),
    optIn: safe(function () { store(STORAGE_OPTOUT, "0"); }),

    flush: flush,
    _queue: function () { return queue.slice(); }
  };

  root.pulse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
