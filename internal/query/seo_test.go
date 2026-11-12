package query

import (
	"net/http"
	"testing"
	"time"
)

func TestChannel(t *testing.T) {
	cases := []struct{ ref, src, med, want string }{
		{"google.com", "", "", ChannelOrganic},
		{"www.google.co.th", "", "", ChannelOrganic},
		{"google.de", "", "", ChannelOrganic},
		{"bing.com", "", "", ChannelOrganic},
		{"duckduckgo.com", "", "", ChannelOrganic},
		{"gemini.google.com", "", "", ChannelAI},
		{"chatgpt.com", "", "", ChannelAI},
		{"$direct", "chatgpt.com", "", ChannelAI}, // ChatGPT adds utm_source=chatgpt.com
		{"perplexity.ai", "", "", ChannelAI},
		{"claude.ai", "", "", ChannelAI},
		{"m.facebook.com", "", "", ChannelSocial},
		{"l.facebook.com", "", "", ChannelSocial},
		{"t.co", "", "", ChannelSocial},
		{"line.me", "", "", ChannelSocial},
		{"$direct", "facebook", "", ChannelSocial},
		{"$direct", "line", "social", ChannelSocial},
		{"google.com", "google", "cpc", ChannelPaid},
		{"$direct", "newsletter", "email", ChannelEmail},
		{"itch.io", "", "", ChannelReferral},
		{"$direct", "partner-site", "", ChannelReferral},
		{"$direct", "", "", ChannelDirect},
		{"", "", "", ChannelDirect},
		{"notgoogle.com", "", "", ChannelReferral},
		{"evilchatgpt.com", "", "", ChannelReferral},
	}
	for _, c := range cases {
		if got := Channel(c.ref, c.src, c.med); got != c.want {
			t.Errorf("Channel(%q,%q,%q) = %q, want %q", c.ref, c.src, c.med, got, c.want)
		}
	}
}

func TestBuildSEO(t *testing.T) {
	r := Range{From: time.Date(2026, 11, 9, 17, 0, 0, 0, time.UTC), To: time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)} // 10th..11th Bangkok
	cur := []VisitRow{
		{Day: "2026-11-10", Landing: "/about.html", Referrer: "google.com", Sessions: 8, Bounces: 2},
		{Day: "2026-11-10", Landing: "/", Referrer: "$direct", Sessions: 5, Bounces: 5},
		{Day: "2026-11-11", Landing: "/about.html", Referrer: "chatgpt.com", Sessions: 3},
		{Day: "2026-11-11", Landing: "", Referrer: "m.facebook.com", Sessions: 4, Bounces: 1},
	}
	prev := []VisitRow{{Day: "2026-11-08", Landing: "/about.html", Referrer: "google.com", Sessions: 2}}
	rep := BuildSEO(cur, prev, r, "Asia/Bangkok")
	if rep.Sessions != 20 || rep.Previous != 2 {
		t.Fatalf("totals %d/%d", rep.Sessions, rep.Previous)
	}
	byCh := map[string]ChannelStat{}
	for _, c := range rep.Channels {
		byCh[c.Channel] = c
	}
	if byCh[ChannelOrganic].Sessions != 8 || byCh[ChannelOrganic].Previous != 2 || byCh[ChannelAI].Sessions != 3 || byCh[ChannelDirect].BounceRate != 1 {
		t.Fatalf("channels %+v", byCh)
	}
	if rep.Landing[0].Page != "/about.html" || rep.Landing[0].Sessions != 11 || rep.Landing[0].Search != 8 || rep.Landing[0].AI != 3 || rep.Landing[0].Previous != 2 {
		t.Fatalf("landing %+v", rep.Landing[0])
	}
	if len(rep.Trend) != 2 || rep.Trend[0].T != "2026-11-10" || rep.Trend[1].Channels[ChannelAI] != 3 {
		t.Fatalf("trend %+v", rep.Trend)
	}
	for _, s := range rep.Sources {
		if s.Source == "(direct)" {
			t.Fatal("direct visits must not be listed as a source")
		}
	}
}

func TestRate(t *testing.T) {
	if Rate("lcp", 2400) != "good" || Rate("lcp", 3000) != "needs-improvement" || Rate("lcp", 4100) != "poor" {
		t.Fatal("lcp thresholds")
	}
	if Rate("cls", 0.1) != "good" || Rate("cls", 0.3) != "poor" || Rate("inp", 250) != "needs-improvement" {
		t.Fatal("cls/inp thresholds")
	}
}

func TestBuildInsights(t *testing.T) {
	daily := make([]Point, 8)
	for i := range daily {
		daily[i] = Point{T: "d", Users: 100}
	}
	daily[7] = Point{T: "2026-11-11", Users: 30}
	in := InsightInput{
		Days: 7,
		Cur:  KPIs{Visitors: 130, Pageviews: 400, Events: 900},
		Prev: KPIs{Visitors: 100},
		SEO: SEOReport{Sessions: 200, Channels: []ChannelStat{
			{Channel: ChannelOrganic, Sessions: 5, Previous: 20},
			{Channel: ChannelAI, Sessions: 4},
		}, Landing: []LandingStat{{Page: "/", Sessions: 60, BounceRate: 0.8}, {Page: "/about.html", Sessions: 10, Search: 5, AI: 4}}},
		Vitals: VitalsReport{
			ByDevice: []VitalsGroup{{Key: "Mobile", Vitals: []Vital{{Metric: "lcp", P75: 4500, Rating: "poor", Samples: 40}}}},
			ByPage:   []VitalsGroup{{Key: "/", Vitals: []Vital{{Metric: "lcp", P75: 5000, Samples: 30}}}},
		},
		EventsCur:  []Row{{Value: "stage_start", Events: 200}, {Value: "stage_complete", Events: 20}, {Value: "$pageview", Events: 400}},
		EventsPrev: []Row{{Value: "stage_start", Events: 190}, {Value: "stage_complete", Events: 90}, {Value: "boss_defeated", Events: 60}},
		Daily:      daily,
	}
	got := map[string]Insight{}
	for _, i := range BuildInsights(in) {
		got[i.Kind] = i
	}
	for _, k := range []string{"traffic_up", "day_drop", "ai_new", "channel_down", "search_low", "top_search_page", "high_bounce", "vital_slow", "event_down"} {
		if _, ok := got[k]; !ok {
			t.Errorf("missing insight %s; got %v", k, got)
		}
	}
	if got["vital_slow"].Params["page"] != "/" || got["vital_slow"].Level != "bad" {
		t.Errorf("vital_slow %+v", got["vital_slow"])
	}
	if got["top_search_page"].Params["page"] != "/about.html" {
		t.Errorf("top page %+v", got["top_search_page"])
	}
	if got["traffic_up"].Params["pct"] != 30.0 {
		t.Errorf("pct %+v", got["traffic_up"].Params)
	}
	// Small numbers produce only the low-traffic tip, nothing else.
	if out := BuildInsights(InsightInput{Cur: KPIs{Visitors: 3, Events: 9}, Prev: KPIs{Visitors: 1}}); len(out) != 1 || out[0].Kind != "low_traffic" {
		t.Errorf("small site: %+v", out)
	}
	if out := BuildInsights(InsightInput{}); len(out) != 1 || out[0].Kind != "no_data" {
		t.Errorf("no data: %+v", out)
	}
	// One-time visitors: 100 new users in week 0, 8 back in week 1.
	out := BuildInsights(InsightInput{Cur: KPIs{Visitors: 100, Events: 500}, Cohorts: []Cohort{
		{Week: "w1", Size: 100, Users: []uint64{100, 8, 3}}, {Week: "w2", Size: 50, Users: []uint64{50}},
	}})
	found := false
	for _, i := range out {
		if i.Kind == "low_return" && i.Params["pct"] == 8.0 {
			found = true
		}
	}
	if !found {
		t.Errorf("low_return missing: %+v", out)
	}
}

func TestSEOEndpoints(t *testing.T) {
	api, _ := newTestAPI()
	h := api.Handler("")
	for _, p := range []string{"/api/seo?days=7", "/api/vitals?days=7", "/api/insights?days=7"} {
		if rec := get(h, p, "rk1"); rec.Code != http.StatusOK {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body)
		}
		if rec := get(h, p, ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without key: %d", p, rec.Code)
		}
	}
}
