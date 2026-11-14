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


  // ---- Insights -------------------------------------------------------------

  var CH = {
    "Organic Search": { th: "Search (Google, Bing)", color: "#047857" },
    "AI": { th: "AI (ChatGPT, Perplexity ฯลฯ)", color: "#7C3AED" },
    "Social": { th: "โซเชียล", color: "#EA580C" },
    "Referral": { th: "เว็บอื่นลิงก์มา", color: "#0891B2" },
    "Paid": { th: "โฆษณา", color: "#DB2777" },
    "Email": { th: "อีเมล", color: "#CA8A04" },
    "Direct": { th: "เข้าตรง", color: "#6B7280" }
  };
  var DEVICE = { Mobile: "มือถือ", Desktop: "คอมพิวเตอร์", Tablet: "แท็บเล็ต", Other: "อื่นๆ", "": "ไม่ทราบ" };
  var abs = function (n) { return Math.abs(n).toFixed(0); };
  var page = function (p) { return '<span class="mono">' + esc(p) + "</span>"; };

  function insightText(i) {
    var p = i.params || {};
    switch (i.kind) {
      case "no_data": return "ยังไม่มีข้อมูลเข้ามาใน " + p.days + " วันนี้ เช็กว่าใส่โค้ด SDK ในเว็บหรือเกมแล้ว และ key กับ host ถูก (ลองกดส่ง event ทดสอบในแท็บ ติดตั้ง แล้วดูแท็บ เหตุการณ์สด)";
      case "low_traffic": return "ยังมีผู้เข้าชมน้อย (" + fmt(p.visitors) + " คนใน " + p.days + " วัน) เริ่มจาก: ส่ง sitemap ใน Google Search Console และ Bing Webmaster Tools, โพสต์ลิงก์ใน itch.io, Reddit, Pantip และกลุ่ม Facebook, ใส่ <span class=\"mono\">?utm_source=</span> ในลิงก์ที่แชร์ จะได้รู้ว่าช่องทางไหนได้ผล";
      case "low_return": return "คนส่วนใหญ่เข้ามาครั้งเดียว: กลับมาในสัปดาห์ถัดไปแค่ <strong>" + p.pct + "%</strong> ลองเพิ่มเหตุผลให้กลับมา เช่น ภารกิจหรือโจทย์รายวัน, รางวัลล็อกอินต่อเนื่อง, อันดับรายสัปดาห์, ปุ่มเพิ่มไปหน้าจอโฮม และช่องทางแจ้งข่าว (LINE OA/เพจ) เวลามีด่านใหม่";
      case "high_return": return "ผู้ใช้กลับมาเล่นซ้ำดี: <strong>" + p.pct + "%</strong> กลับมาในสัปดาห์ถัดไป";
      case "traffic_up": return "ผู้เข้าชม " + p.days + " วันนี้เพิ่มขึ้น <strong>" + abs(p.pct) + "%</strong> เทียบช่วงก่อน (" + fmt(p.visitors) + " คน)";
      case "traffic_down": return "ผู้เข้าชม " + p.days + " วันนี้ลดลง <strong>" + abs(p.pct) + "%</strong> เทียบช่วงก่อน (" + fmt(p.visitors) + " คน) ดูแท็บ SEO ว่าช่องทางไหนลด";
      case "traffic_new": return "เริ่มมีผู้เข้าชม " + fmt(p.visitors) + " คนใน " + p.days + " วันนี้";
      case "day_drop": return "เมื่อวาน (" + esc(p.day) + ") มีผู้ใช้ " + fmt(p.users) + " คน <strong>ต่ำกว่าปกติ " + abs(p.pct) + "%</strong> (เฉลี่ย 7 วัน " + fmt(p.avg) + ") ลองเช็กว่าเว็บล่มหรือโค้ด tracking หายไหม";
      case "day_spike": return "เมื่อวาน (" + esc(p.day) + ") มีผู้ใช้ " + fmt(p.users) + " คน <strong>สูงกว่าปกติ " + abs(p.pct) + "%</strong> ดูแท็บ SEO ว่ามาจากไหน";
      case "ai_new": return "เริ่มมีคนมาจาก <strong>AI</strong> (ChatGPT, Perplexity, Gemini ฯลฯ) แล้ว " + fmt(p.sessions) + " ครั้ง";
      case "channel_up": return (CH[p.channel] || { th: p.channel }).th + " <strong>เพิ่มขึ้น " + abs(p.pct) + "%</strong> (" + fmt(p.sessions) + " ครั้ง)";
      case "channel_down": return (CH[p.channel] || { th: p.channel }).th + " <strong>ลดลง " + abs(p.pct) + "%</strong> (" + fmt(p.sessions) + " ครั้ง)" + (p.channel === "Organic Search" ? " ลองเช็กอันดับใน Google Search Console" : "");
      case "search_low": return "คนมาจาก Google/Bing แค่ <strong>" + p.share + "%</strong> ของการเข้าชม แนะนำส่ง sitemap ใน Google Search Console และ Bing Webmaster Tools (ดูเช็กลิสต์ในแท็บ SEO)";
      case "top_search_page": return "หน้า " + page(p.page) + " ดึงคนจาก Search และ AI ได้มากที่สุด (" + fmt(p.sessions) + " ครั้ง) ทำหน้าแบบนี้เพิ่มได้";
      case "high_bounce": return "หน้า " + page(p.page) + " คนเข้าแล้วออกเลย <strong>" + p.rate + "%</strong> (" + fmt(p.sessions) + " ครั้ง) ลองทำปุ่มหรือลิงก์ชวนไปต่อให้เห็นชัดขึ้น";
      case "vital_slow":
        var where = " บน" + (DEVICE[p.device] || esc(p.device)) + (p.page ? " ช้าสุดที่ " + page(p.page) : "");
        if (p.metric === "lcp") return "หน้าโหลดช้า" + where + " (LCP <strong>" + (p.p75 / 1000).toFixed(1) + " วินาที</strong> ควรไม่เกิน 2.5) ลองลดขนาดรูปและไฟล์ที่โหลดตอนเปิด";
        if (p.metric === "inp") return "กดแล้วตอบสนองช้า" + where + " (INP <strong>" + fmt(p.p75) + " ms</strong> ควรไม่เกิน 200)";
        return "หน้าเลื่อน/กระตุกตอนโหลด" + where + " (CLS <strong>" + p.p75.toFixed(2) + "</strong> ควรไม่เกิน 0.1) ใส่ width และ height ให้รูป";
      case "vitals_missing": return "ยังไม่มีข้อมูลความเร็วหน้าเว็บ ใช้ SDK เวอร์ชันล่าสุด (โหลดจาก /sdk/analytics.js) ระบบจะเก็บให้อัตโนมัติ";
      case "event_down": return "event <span class=\"mono\">" + esc(p.event) + "</span> <strong>ลดลง " + abs(p.pct) + "%</strong> (" + fmt(p.previous) + " → " + fmt(p.count) + ") ถ้าเป็นเกม อาจมีบั๊กหรือด่านยากไป";
      case "event_up": return "event <span class=\"mono\">" + esc(p.event) + "</span> <strong>เพิ่มขึ้น " + abs(p.pct) + "%</strong> (" + fmt(p.previous) + " → " + fmt(p.count) + ")";
    }
    return esc(i.kind);
  }

  function loadInsights() {
    api("insights?days=" + state.days).then(function (list) {
      $("#insights").innerHTML = (list || []).map(function (i) {
        return '<li class="' + esc(i.level) + '"><i aria-hidden="true"></i><span>' + insightText(i) + "</span></li>";
      }).join("") || '<li class="info"><i aria-hidden="true"></i><span>ยังไม่มีอะไรผิดปกติ ระบบจะเตือนเมื่อมีข้อมูลพอเปรียบเทียบ</span></li>';
    }).catch(function () { $("#insights").innerHTML = '<li class="info"><i></i><span>โหลด insight ไม่สำเร็จ</span></li>'; });
  }

  // ---- SEO ------------------------------------------------------------------

  function chg(cur, prev) {
    if (!prev) return cur ? '<span class="delta good">ใหม่</span>' : '<span class="muted">–</span>';
    var pct = (cur - prev) / prev * 100;
    return '<span class="delta ' + (pct >= 0 ? "good" : "bad") + '">' + (pct >= 0 ? "▲ " : "▼ ") + Math.abs(pct).toFixed(0) + "%</span>";
  }

  function multiLine(series, labels) {
    var n = labels.length;
    if (!n) return '<p class="muted">ยังไม่มีข้อมูล</p>';
    var max = 1;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    max *= 1.1;
    var paths = series.map(function (s) {
      var d = "M" + s.values.map(function (v, i) {
        return (n === 1 ? 300 : i / (n - 1) * 600).toFixed(1) + " " + (200 - v / max * 190).toFixed(1);
      }).join(" L");
      return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
    }).join("");
    var months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    var lab = function (t) { var p = t.split("-"); return Number(p[2]) + " " + months[Number(p[1]) - 1]; };
    var ticks = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return labels[Math.round(f * (n - 1))]; });
    return '<svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="กราฟการเข้าชมแยกตามช่องทาง">' +
      [50, 100, 150].map(function (y) { return '<line x1="0" x2="600" y1="' + y + '" y2="' + y + '" stroke="#EEF0F3" vector-effect="non-scaling-stroke"/>'; }).join("") +
      paths + '</svg><div class="axis">' + ticks.map(function (t) { return "<span>" + esc(lab(t)) + "</span>"; }).join("") + "</div>";
  }

  function loadSEO() {
    var d = state.days;
    api("seo?days=" + d).then(function (r) {
      var by = {};
      r.channels.forEach(function (c) { by[c.channel] = c; });
      var org = by["Organic Search"], ai = by["AI"];
      var share = r.sessions ? (org.sessions + ai.sessions) / r.sessions * 100 : 0;
      $("#seo-kpis").innerHTML = [
        ["การเข้าชมทั้งหมด", fmt(r.sessions), chg(r.sessions, r.previous)],
        ["จาก Search (Google, Bing)", fmt(org.sessions), chg(org.sessions, org.previous)],
        ["จาก AI", fmt(ai.sessions), chg(ai.sessions, ai.previous)],
        ["สัดส่วน Search + AI", share.toFixed(1) + "%", '<span class="muted">ของการเข้าชมทั้งหมด</span>']
      ].map(function (k) {
        return '<div class="kpi"><span class="label">' + k[0] + '</span><span class="value">' + k[1] + "</span>" + k[2] + "</div>";
      }).join("");

      var shown = r.channels.filter(function (c) { return c.sessions > 0 || c.channel === "Organic Search" || c.channel === "AI"; });
      var series = shown.map(function (c) {
        return { color: CH[c.channel].color, values: r.trend.map(function (p) { return p.channels[c.channel] || 0; }) };
      });
      $("#seo-trend").innerHTML = multiLine(series, r.trend.map(function (p) { return p.t; }));
      $("#seo-legend").innerHTML = shown.map(function (c) {
        return '<span><i style="background:' + CH[c.channel].color + '"></i>' + esc(CH[c.channel].th) + "</span>";
      }).join("");

      $("#seo-channels").innerHTML = '<thead><tr><th>ช่องทาง</th><th class="num">ครั้ง</th><th class="num">เทียบก่อน</th><th class="num">ออกทันที</th></tr></thead><tbody>' +
        r.channels.map(function (c) {
          return '<tr><td><span class="chip" style="background:' + CH[c.channel].color + '"></span>' + esc(CH[c.channel].th) + '</td><td class="num">' + fmt(c.sessions) +
            '</td><td class="num">' + chg(c.sessions, c.previous) + '</td><td class="num">' + (c.sessions ? (c.bounce_rate * 100).toFixed(0) + "%" : "–") + "</td></tr>";
        }).join("") + "</tbody>";

      var engines = r.sources.filter(function (s) { return s.channel === "Organic Search" || s.channel === "AI"; })
        .map(function (s) { return { value: s.source + (s.channel === "AI" ? " (AI)" : ""), events: s.sessions }; });
      $("#seo-sources").innerHTML = engines.length ? bars(engines, "events", false) :
        '<p class="muted">ยังไม่มีคนมาจาก Search หรือ AI ในช่วงนี้ ดูเช็กลิสต์ด้านล่าง</p>';

      $("#seo-landing").innerHTML = '<thead><tr><th>หน้า</th><th class="num">เข้าชม</th><th class="num">จาก Search</th><th class="num">จาก AI</th><th class="num">ออกทันที</th><th class="num">เทียบก่อน</th></tr></thead><tbody>' +
        (r.landing.map(function (l) {
          return '<tr><td class="mono">' + esc(l.page) + '</td><td class="num">' + fmt(l.sessions) + '</td><td class="num">' + fmt(l.search) +
            '</td><td class="num">' + fmt(l.ai) + '</td><td class="num">' + (l.bounce_rate * 100).toFixed(0) + '%</td><td class="num">' + chg(l.sessions, l.previous) + "</td></tr>";
        }).join("") || '<tr><td colspan="6" class="muted">ยังไม่มีข้อมูล</td></tr>') + "</tbody>";
    }).catch(noop);

    api("vitals?days=" + d).then(function (v) {
      var names = { lcp: ["LCP", "โหลดเนื้อหาหลักเสร็จ"], inp: ["INP", "ตอบสนองเมื่อกด"], cls: ["CLS", "หน้าไม่กระตุก"], fcp: ["FCP", "เริ่มเห็นหน้าเว็บ"], ttfb: ["TTFB", "เซิร์ฟเวอร์ตอบกลับ"] };
      var rateTH = { good: "ดี", "needs-improvement": "ควรปรับ", poor: "แย่" };
      var val = function (m, x) { return m === "cls" ? x.toFixed(2) : (x >= 1000 ? (x / 1000).toFixed(2) + " s" : Math.round(x) + " ms"); };
      $("#vitals").innerHTML = (v.overall || []).map(function (x) {
        return '<div class="vital"><span class="label">' + names[x.metric][0] + " · " + names[x.metric][1] + '</span><span class="value">' + val(x.metric, x.p75) +
          '</span><span><span class="rate ' + x.rating + '">' + rateTH[x.rating] + '</span> <span class="muted">' + fmt(x.samples) + " ครั้ง</span></span></div>";
      }).join("") || '<p class="muted">ยังไม่มีข้อมูล ระบบจะเก็บอัตโนมัติเมื่อหน้าเว็บใช้ SDK เวอร์ชันล่าสุด</p>';
      var table = function (groups, label) {
        if (!groups || !groups.length) return '<tbody><tr><td class="muted">ยังไม่มีข้อมูล</td></tr></tbody>';
        var cell = function (g, m) {
          var x = (g.vitals || []).filter(function (y) { return y.metric === m; })[0];
          return x ? '<span class="rate ' + x.rating + '">' + val(m, x.p75) + "</span>" : "–";
        };
        return '<thead><tr><th>' + label + '</th><th class="num">LCP</th><th class="num">INP</th><th class="num">CLS</th></tr></thead><tbody>' +
          groups.map(function (g) {
            var k = label === "อุปกรณ์" ? (DEVICE[g.key] || g.key) : g.key;
            return "<tr><td" + (label === "หน้า" ? ' class="mono"' : "") + ">" + esc(k) + '</td><td class="num">' + cell(g, "lcp") + '</td><td class="num">' + cell(g, "inp") + '</td><td class="num">' + cell(g, "cls") + "</td></tr>";
          }).join("") + "</tbody>";
      };
      $("#vitals-device").innerHTML = table(v.by_device, "อุปกรณ์");
      $("#vitals-page").innerHTML = table(v.by_page, "หน้า");
    }).catch(noop);
  }

  // ---- Funnel ---------------------------------------------------------------

  // Steps are remembered per project. Without saved steps, guess them from
  // this project's own events: custom events with the most users first
  // (a rough funnel order), starting from $pageview when there are few.
  function funnelKey() { return "gstats_funnel_" + (state.config ? state.config.app_id : ""); }

  // guessSteps takes the 4 custom events most users did, then puts them in
  // the order players usually reach them (the server's "order" field).
  function guessSteps(rows) {
    var custom = rows.filter(function (r) { return r.value && r.value.charAt(0) !== "$"; })
      .sort(function (a, b) { return b.users - a.users || b.events - a.events; })
      .slice(0, 4)
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .map(function (r) { return r.value; });
    if (custom.length < 3 && rows.some(function (r) { return r.value === "$pageview"; })) custom.unshift("$pageview");
    return custom;
  }

  function loadFunnel() {
    api("events?days=" + state.days).then(function (rows) {
      $("#event-names").innerHTML = rows.map(function (r) {
        return '<button type="button" class="chip-btn" data-ev="' + esc(r.value) + '">' + esc(r.value) + "</button>";
      }).join(" ") || "-";
      var input = $("#funnel-steps");
      if (input.value.trim()) return runFunnel();
      var saved = null;
      try { saved = localStorage.getItem(funnelKey()); } catch (e) {}
      var steps = saved ? saved.split(",") : guessSteps(rows);
      input.value = steps.join(",");
      if (steps.length >= 2) runFunnel();
      else $("#funnel").innerHTML = '<p class="muted">ยังมี event ไม่พอสำหรับ funnel ใส่ชื่อ event อย่างน้อย 2 ขั้น หรือรอให้มีผู้เล่นมากขึ้น</p>';
    }).catch(function (e) { $("#funnel").innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; });
  }

  function saveFunnel() {
    var steps = $("#funnel-steps").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean).join(",");
    try { localStorage.setItem(funnelKey(), steps); } catch (e) {}
  }

  function runFunnel() {
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
      '<script src="' + origin + '/sdk/analytics.js"></script>\n<script>\n  gstats.init({ key: "' + c.write_key + '", host: "' + c.collector_url + '" });\n' +
      '  // gstats.capture("add_to_cart", { sku: "SNK-X", price: 2490 });\n  // gstats.identify("user_123");\n</script>';
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
    if (state.tab === "overview") { loadOverview(); loadInsights(); }
    if (state.tab === "seo") loadSEO();
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
      $("#project").textContent = (c.name || "app_id " + c.app_id) + " · " + c.timezone;
      if (c.name) document.title = c.name + " · gstats";
      render();
    }).catch(noop);
  }

  $$(".tabs button").forEach(function (b) { b.addEventListener("click", function () { state.tab = b.dataset.tab; render(); }); });
  $$(".seg button").forEach(function (b) { b.addEventListener("click", function () { state.days = Number(b.dataset.days); render(); }); });
  $$("[data-test]").forEach(function (b) { b.addEventListener("click", function () { sendTest(b.dataset.test); }); });
  $("#funnel-form").addEventListener("submit", function (e) { e.preventDefault(); saveFunnel(); runFunnel(); });
  $("#event-names").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-ev]");
    if (!b) return;
    var input = $("#funnel-steps");
    var list = input.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    list.push(b.getAttribute("data-ev"));
    input.value = list.slice(-8).join(",");
  });
  $("#login-form").addEventListener("submit", function (e) { e.preventDefault(); start($("#key").value.trim()); });

  var params = new URLSearchParams(location.search);
  var saved = params.get("key");
  if (!saved) { try { saved = localStorage.getItem("pulse_read_key"); } catch (e) {} }
  if (saved) start(saved); else showLogin();
})();
