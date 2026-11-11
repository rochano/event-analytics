(function () {
  "use strict";

  var state = { key: "", days: 30, tab: "overview", config: null, liveTimer: null };
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var nf = new Intl.NumberFormat("en-US");
  var fmt = function (n) { return nf.format(Math.round(n || 0)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function api(path) {
    return fetch("/api/" + path, { headers: { "X-Read-Key": state.key } }).then(function (r) {
      if (r.status === 401) { showLogin("Read key ไม่ถูกต้อง"); throw new Error("unauthorized"); }
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b.error || r.statusText);
        return b.data !== undefined ? b.data : b;
      });
    });
  }

  function showLogin(msg) {
    $("#login").classList.remove("hidden");
    $$(".tab").forEach(function (t) { t.classList.add("hidden"); });
    $("#login-error").textContent = msg || "";
  }

  // ---- Overview -------------------------------------------------------------

  function delta(cur, prev, higherIsGood) {
    if (!prev) return '<span class="delta muted">ไม่มีข้อมูลช่วงก่อน</span>';
    var pct = (cur - prev) / prev * 100;
    var up = pct >= 0;
    var good = up === higherIsGood;
    return '<span class="delta ' + (good ? "good" : "bad") + '">' + (up ? "▲ " : "▼ ") + Math.abs(pct).toFixed(1) + "% เทียบช่วงก่อน</span>";
  }

  function duration(s) {
    s = Math.round(s || 0);
    return Math.floor(s / 60) + " น. " + (s % 60) + " วิ";
  }

  function loadOverview() {
    var d = state.days;
    api("overview?days=" + d).then(function (o) {
      var c = o.current, p = o.previous;
      $("#active").textContent = fmt(o.active_now);
      $("#kpis").innerHTML = [
        ["ผู้เข้าชมไม่ซ้ำ", fmt(c.visitors), delta(c.visitors, p.visitors, true)],
        ["การดูหน้า (Pageviews)", fmt(c.pageviews), delta(c.pageviews, p.pageviews, true)],
        ["อัตราตีกลับ (Bounce)", (c.bounce_rate * 100).toFixed(1) + "%", delta(c.bounce_rate, p.bounce_rate, false)],
        ["เวลาเฉลี่ยต่อ session", duration(c.avg_session_secs), delta(c.avg_session_secs, p.avg_session_secs, true)]
      ].map(function (k) {
        return '<div class="kpi"><span class="label">' + k[0] + '</span><span class="value">' + k[1] + "</span>" + k[2] + "</div>";
      }).join("");
    }).catch(noop);

    api("trend?days=" + d).then(function (pts) {
      $("#trend-label").textContent = d + " วันล่าสุด";
      $("#trend").innerHTML = lineChart(pts.map(function (x) { return x.users; }), pts.map(function (x) { return x.t; }));
    }).catch(noop);

    api("breakdown?dim=pathname&event=%24pageview&limit=8&days=" + d).then(function (rows) {
      $("#top-pages").innerHTML = bars(rows, "events", true);
    }).catch(noop);
    api("breakdown?dim=referrer_domain&limit=8&days=" + d).then(function (rows) {
      rows.forEach(function (r) { if (r.value === "$direct") r.value = "Direct (เข้าตรง)"; });
      rows.sort(function (a, b) { return b.users - a.users; });
      $("#top-sources").innerHTML = bars(rows, "users", false);
    }).catch(noop);
    api("breakdown?dim=country_code&limit=8&days=" + d).then(function (rows) {
      $("#countries").innerHTML = bars(rows, "users", false);
    }).catch(noop);
    api("breakdown?dim=device_type&limit=5&days=" + d).then(function (rows) {
      var colors = ["#1D4ED8", "#EA580C", "#6B7280", "#047857", "#7C3AED"];
      var total = rows.reduce(function (a, r) { return a + r.users; }, 0) || 1;
      var names = { Mobile: "มือถือ", Desktop: "คอมพิวเตอร์", Tablet: "แท็บเล็ต", "": "ไม่ทราบ" };
      $("#devices").innerHTML = '<div class="stack">' + rows.map(function (r, i) {
        return '<div style="width:' + (r.users / total * 100) + "%;background:" + colors[i % 5] + '"></div>';
      }).join("") + '</div><div class="legend">' + rows.map(function (r, i) {
        return '<span><i style="background:' + colors[i % 5] + '"></i>' + esc(names[r.value] || r.value) + " " + Math.round(r.users / total * 100) + "%</span>";
      }).join("") + "</div>";
    }).catch(noop);
  }

  function bars(rows, field, mono) {
    if (!rows || !rows.length) return '<p class="muted">ยังไม่มีข้อมูล</p>';
    var top = Math.max.apply(null, rows.map(function (r) { return r[field]; })) || 1;
    return rows.map(function (r) {
      return '<div class="item"><div class="head"><span' + (mono ? ' class="mono"' : "") + ">" + esc(r.value || "(ไม่ระบุ)") +
        "</span><strong>" + fmt(r[field]) + '</strong></div><div class="track"><div class="fill" style="width:' +
        (r[field] / top * 100).toFixed(1) + '%"></div></div></div>';
    }).join("");
  }

  function lineChart(values, labels) {
    if (!values.length) return '<p class="muted">ยังไม่มีข้อมูล</p>';
    var max = Math.max.apply(null, values) * 1.1 || 1;
    var n = values.length;
    var pts = values.map(function (v, i) {
      var x = n === 1 ? 300 : i / (n - 1) * 600;
      return x.toFixed(1) + " " + (200 - v / max * 190).toFixed(1);
    });
    var line = "M" + pts.join(" L");
    var ticks = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return labels[Math.round(f * (n - 1))]; });
    var months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    var label = function (t) { var p = t.split("-"); return Number(p[2]) + " " + months[Number(p[1]) - 1]; };
    return '<svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="กราฟผู้เข้าชมรายวัน">' +
      [50, 100, 150].map(function (y) { return '<line x1="0" x2="600" y1="' + y + '" y2="' + y + '" stroke="#EEF0F3" vector-effect="non-scaling-stroke"/>'; }).join("") +
      '<path d="' + line + ' L600 200 L0 200 Z" fill="#1D4ED8" fill-opacity="0.08"/>' +
      '<path d="' + line + '" fill="none" stroke="#1D4ED8" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>' +
      '<div class="axis">' + ticks.map(function (t) { return "<span>" + esc(label(t)) + "</span>"; }).join("") + "</div>";
  }

  // ---- Funnel ---------------------------------------------------------------

  function loadFunnel() {
    api("events?days=" + state.days).then(function (rows) {
      $("#event-names").textContent = rows.map(function (r) { return r.value; }).join(", ") || "-";
    }).catch(noop);
    var steps = $("#funnel-steps").value;
    var win = $("#funnel-window").value;
    $("#funnel").innerHTML = '<p class="muted">กำลังคำนวณ…</p>';
    api("funnel?days=" + state.days + "&window=" + win + "&steps=" + encodeURIComponent(steps)).then(function (res) {
      var first = res[0].users || 1;
      var last = res[res.length - 1].users;
      $("#funnel").innerHTML = '<p>ทำครบทุกขั้น <strong>' + (last / first * 100).toFixed(1) + "%</strong> ของคนที่เริ่มขั้นแรก</p>" +
        res.map(function (s, i) {
          var next = res[i + 1];
          return '<div class="step"><div class="head"><span><strong>' + (i + 1) + ".</strong> " + esc(s.event) +
            "</span><span><strong>" + fmt(s.users) + '</strong> คน <span class="muted">(' + (s.users / first * 100).toFixed(1) +
            '%)</span></span></div><div class="track"><div class="fill" style="opacity:' + (1 - i * 0.12) + ";width:" +
            (s.users / first * 100).toFixed(1) + '%"></div></div>' +
            (next ? '<span class="drop">หลุดก่อนขั้นถัดไป ' + fmt(s.users - next.users) + " คน (" +
              (s.users ? ((1 - next.users / s.users) * 100).toFixed(0) : 0) + "%)</span>" : "") + "</div>";
        }).join("");
    }).catch(function (e) { $("#funnel").innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; });
  }

  // ---- Retention ------------------------------------------------------------

  function loadRetention() {
    api("retention?weeks=8").then(function (rows) {
      var cols = 8;
      var html = '<div class="ret" style="grid-template-columns:110px 70px repeat(' + cols + ',minmax(0,1fr))">' +
        '<span class="h l">เริ่มสัปดาห์</span><span class="h l">ผู้ใช้</span>';
      for (var i = 0; i < cols; i++) html += '<span class="h">W' + i + "</span>";
      rows.forEach(function (r) {
        html += "<span>" + esc(r.week) + '</span><span class="muted">' + fmt(r.size) + "</span>";
        for (var i = 0; i < cols; i++) {
          if (i < r.users.length && r.size) {
            var pct = r.users[i] / r.size * 100;
            var a = pct / 100 * 0.9 + 0.06;
            html += '<span class="c" style="background:rgba(29,78,216,' + a.toFixed(2) + ");color:" + (a > 0.45 ? "#fff" : "#111827") + '">' + pct.toFixed(0) + "%</span>";
          } else {
            html += "<span></span>";
          }
        }
      });
      $("#retention").innerHTML = html + "</div>";
    }).catch(noop);
  }

  // ---- Live -----------------------------------------------------------------

  function loadLive() {
    api("live?limit=40").then(function (res) {
      $("#active").textContent = fmt(res.active_now);
      $("#live tbody").innerHTML = (res.events || []).map(function (e) {
        var cls = e.event === "purchase" ? "badge p" : (e.event === "add_to_cart" ? "badge c" : "badge");
        var t = new Date(e.timestamp).toLocaleTimeString("th-TH", { hour12: false });
        return "<tr><td>" + t + '</td><td><span class="' + cls + '">' + esc(e.event) + '</span></td><td class="mono">' +
          esc(e.distinct_id) + '</td><td class="mono">' + esc(e.pathname) + "</td><td>" + esc(e.country) + "</td><td>" + esc(e.device) + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="muted">ยังไม่มี event ใน 24 ชั่วโมงล่าสุด</td></tr>';
    }).catch(noop);
  }

  // ---- Setup ----------------------------------------------------------------

  function loadSetup() {
    var c = state.config;
    if (!c) return;
    var origin = location.origin;
    $("#snippet").textContent =
      '<script src="' + origin + '/sdk/analytics.js"></script>\n<script>\n  pulse.init({ key: "' + c.write_key + '", host: "' + c.collector_url + '" });\n' +
      '  // pulse.capture("add_to_cart", { sku: "SNK-X", price: 2490 });\n  // pulse.identify("user_123");\n</script>';
    $("#curl").textContent =
      "curl -X POST " + c.collector_url + "/e \\\n  -H 'Content-Type: application/json' -H 'X-Api-Key: " + c.write_key + "' \\\n" +
      "  -d '[{\"event\":\"level_complete\",\"distinct_id\":\"player_1\",\"properties\":{\"level_id\":\"w1_s3\",\"stars\":3}}]'";
  }

  function sendTest(name) {
    var c = state.config;
    var props = { $current_url: location.origin + "/demo", $lib: "dashboard-test" };
    if (name === "level_complete") { props.level_id = "w1_s3"; props.stars = 3; }
    if (name === "add_to_cart") { props.sku = "SNK-X"; props.price = 2490; }
    fetch(c.collector_url + "/e", {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ api_key: c.write_key, batch: [{ event: name, distinct_id: "dashboard_tester", properties: props }] })
    }).then(function (r) {
      $("#test-result").textContent = r.status === 204 ? "ส่งแล้ว (204) ดูได้ที่แท็บ เหตุการณ์สด" : "ตอบกลับ " + r.status;
    }).catch(function (e) { $("#test-result").textContent = "ส่งไม่สำเร็จ: " + e.message; });
  }

  // ---- Wiring ---------------------------------------------------------------

  function noop() {}

  function render() {
    $$(".tabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === state.tab); });
    $$(".seg button").forEach(function (b) { b.classList.toggle("on", Number(b.dataset.days) === state.days); });
    $$(".tab").forEach(function (t) { t.classList.toggle("hidden", t.id !== "tab-" + state.tab); });
    clearInterval(state.liveTimer);
    if (state.tab === "overview") loadOverview();
    if (state.tab === "funnel") loadFunnel();
    if (state.tab === "retention") loadRetention();
    if (state.tab === "live") { loadLive(); state.liveTimer = setInterval(loadLive, 5000); }
    if (state.tab === "setup") loadSetup();
  }

  function start(key) {
    state.key = key;
    api("config").then(function (c) {
      state.config = c;
      try { localStorage.setItem("pulse_read_key", key); } catch (e) {}
      $("#login").classList.add("hidden");
      $("#project").textContent = "app_id " + c.app_id + " · " + c.timezone;
      render();
    }).catch(noop);
  }

  $$(".tabs button").forEach(function (b) { b.addEventListener("click", function () { state.tab = b.dataset.tab; render(); }); });
  $$(".seg button").forEach(function (b) { b.addEventListener("click", function () { state.days = Number(b.dataset.days); render(); }); });
  $$("[data-test]").forEach(function (b) { b.addEventListener("click", function () { sendTest(b.dataset.test); }); });
  $("#funnel-form").addEventListener("submit", function (e) { e.preventDefault(); loadFunnel(); });
  $("#login-form").addEventListener("submit", function (e) { e.preventDefault(); start($("#key").value.trim()); });

  var params = new URLSearchParams(location.search);
  var saved = params.get("key");
  if (!saved) { try { saved = localStorage.getItem("pulse_read_key"); } catch (e) {} }
  if (saved) start(saved); else showLogin();
})();
