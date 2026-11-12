package query

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"
)

// Insight is one automatic finding for the dashboard. Kind and Params are
// data; the dashboard turns them into sentences, so the API stays
// language-neutral.
type Insight struct {
	Kind   string         `json:"kind"`
	Level  string         `json:"level"` // bad, warn, good, info
	Params map[string]any `json:"params"`
}

var levelOrder = map[string]int{"bad": 0, "warn": 1, "good": 2, "info": 3}

// InsightInput is everything the rules look at.
type InsightInput struct {
	Days       int
	Cur, Prev  KPIs
	SEO        SEOReport
	Vitals     VitalsReport
	EventsCur  []Row
	EventsPrev []Row
	Daily      []Point // complete days, oldest first; the last one is yesterday
}

func pct(cur, prev uint64) float64 {
	if prev == 0 {
		return 0
	}
	return math.Round((float64(cur)/float64(prev)-1)*1000) / 10
}

// BuildInsights applies the rules. Thresholds keep small numbers from
// producing noise: a change needs a minimum volume before it is reported.
func BuildInsights(in InsightInput) []Insight {
	var out []Insight
	add := func(kind, level string, p map[string]any) {
		out = append(out, Insight{Kind: kind, Level: level, Params: p})
	}

	// 1. Visitors versus the previous period.
	if in.Prev.Visitors >= 20 || in.Cur.Visitors >= 20 {
		if in.Prev.Visitors == 0 {
			add("traffic_new", "good", map[string]any{"visitors": in.Cur.Visitors, "days": in.Days})
		} else if p := pct(in.Cur.Visitors, in.Prev.Visitors); p >= 20 {
			add("traffic_up", "good", map[string]any{"pct": p, "visitors": in.Cur.Visitors, "days": in.Days})
		} else if p <= -20 {
			add("traffic_down", "warn", map[string]any{"pct": p, "visitors": in.Cur.Visitors, "days": in.Days})
		}
	}

	// 2. Yesterday against the 7 days before it.
	if n := len(in.Daily); n >= 8 {
		var sum uint64
		for _, d := range in.Daily[n-8 : n-1] {
			sum += d.Users
		}
		avg := float64(sum) / 7
		y := in.Daily[n-1]
		if avg >= 10 {
			ratio := float64(y.Users) / avg
			switch {
			case ratio <= 0.6:
				add("day_drop", "bad", map[string]any{"day": y.T, "users": y.Users, "avg": math.Round(avg), "pct": math.Round((ratio-1)*1000) / 10})
			case ratio >= 2:
				add("day_spike", "good", map[string]any{"day": y.T, "users": y.Users, "avg": math.Round(avg), "pct": math.Round((ratio-1)*1000) / 10})
			}
		}
	}

	// 3. Channels: search and AI growth or loss, AI arriving for the first time.
	for _, c := range in.SEO.Channels {
		if c.Channel != ChannelOrganic && c.Channel != ChannelAI && c.Channel != ChannelSocial {
			continue
		}
		switch {
		case c.Channel == ChannelAI && c.Previous == 0 && c.Sessions >= 3:
			add("ai_new", "good", map[string]any{"sessions": c.Sessions})
		case c.Previous >= 10 && pct(c.Sessions, c.Previous) >= 30:
			add("channel_up", "good", map[string]any{"channel": c.Channel, "pct": pct(c.Sessions, c.Previous), "sessions": c.Sessions})
		case c.Previous >= 10 && pct(c.Sessions, c.Previous) <= -30:
			add("channel_down", "warn", map[string]any{"channel": c.Channel, "pct": pct(c.Sessions, c.Previous), "sessions": c.Sessions})
		}
	}
	var organic uint64
	for _, c := range in.SEO.Channels {
		if c.Channel == ChannelOrganic {
			organic = c.Sessions
		}
	}
	if in.SEO.Sessions >= 50 && float64(organic) < 0.05*float64(in.SEO.Sessions) {
		add("search_low", "info", map[string]any{"share": math.Round(float64(organic)/float64(in.SEO.Sessions)*1000) / 10, "sessions": in.SEO.Sessions})
	}

	// 4. Landing pages: the best search page and pages people leave at once.
	var best *LandingStat
	for i := range in.SEO.Landing {
		l := &in.SEO.Landing[i]
		if l.Search+l.AI >= 5 && (best == nil || l.Search+l.AI > best.Search+best.AI) {
			best = l
		}
	}
	if best != nil {
		add("top_search_page", "info", map[string]any{"page": best.Page, "sessions": best.Search + best.AI})
	}
	for _, l := range in.SEO.Landing {
		if l.Sessions >= 20 && l.BounceRate >= 0.7 {
			add("high_bounce", "warn", map[string]any{"page": l.Page, "rate": math.Round(l.BounceRate * 100), "sessions": l.Sessions})
			break // the busiest one is enough
		}
	}

	// 5. Core Web Vitals: report the worst rating among LCP, INP and CLS.
	worstPage := func(metric string) string {
		var page string
		var worst float64
		for _, g := range in.Vitals.ByPage {
			for _, v := range g.Vitals {
				if v.Metric == metric && v.Samples >= 5 && v.P75 > worst {
					worst, page = v.P75, g.Key
				}
			}
		}
		return page
	}
	for _, g := range in.Vitals.ByDevice {
		for _, v := range g.Vitals {
			if v.Samples < 20 || (v.Metric != "lcp" && v.Metric != "inp" && v.Metric != "cls") {
				continue
			}
			if v.Rating == "poor" || v.Rating == "needs-improvement" {
				level := "warn"
				if v.Rating == "poor" {
					level = "bad"
				}
				add("vital_slow", level, map[string]any{"metric": v.Metric, "device": g.Key, "p75": v.P75, "rating": v.Rating, "page": worstPage(v.Metric)})
			}
		}
	}
	if len(in.Vitals.Overall) == 0 && in.Cur.Pageviews >= 20 {
		add("vitals_missing", "info", nil)
	}

	// 6. Custom events (game or product actions) that fell or grew sharply.
	prev := map[string]uint64{}
	for _, r := range in.EventsPrev {
		prev[r.Value] = r.Events
	}
	type change struct {
		ev       string
		cur, old uint64
	}
	var drops, grows []change
	for _, r := range in.EventsCur {
		if strings.HasPrefix(r.Value, "$") {
			continue
		}
		old := prev[r.Value]
		switch {
		case old >= 50 && float64(r.Events) <= 0.5*float64(old):
			drops = append(drops, change{r.Value, r.Events, old})
		case old >= 50 && float64(r.Events) >= 2*float64(old):
			grows = append(grows, change{r.Value, r.Events, old})
		}
	}
	for _, r := range in.EventsPrev {
		if !strings.HasPrefix(r.Value, "$") && r.Events >= 50 && !hasEvent(in.EventsCur, r.Value) {
			drops = append(drops, change{r.Value, 0, r.Events})
		}
	}
	sort.Slice(drops, func(i, j int) bool { return drops[i].old-drops[i].cur > drops[j].old-drops[j].cur })
	for i, d := range drops {
		if i == 2 {
			break
		}
		add("event_down", "warn", map[string]any{"event": d.ev, "count": d.cur, "previous": d.old, "pct": pct(d.cur, d.old)})
	}
	sort.Slice(grows, func(i, j int) bool { return grows[i].cur-grows[i].old > grows[j].cur-grows[j].old })
	if len(grows) > 0 {
		g := grows[0]
		add("event_up", "good", map[string]any{"event": g.ev, "count": g.cur, "previous": g.old, "pct": pct(g.cur, g.old)})
	}

	sort.SliceStable(out, func(i, j int) bool { return levelOrder[out[i].Level] < levelOrder[out[j].Level] })
	if len(out) > 10 {
		out = out[:10]
	}
	return out
}

func hasEvent(rows []Row, ev string) bool {
	for _, r := range rows {
		if r.Value == ev {
			return true
		}
	}
	return false
}

// insightsFor gathers the inputs from the backend.
func insightsFor(ctx context.Context, b Backend, appID uint32, rg Range, days int, now time.Time, tz string) ([]Insight, error) {
	in := InsightInput{Days: days}
	var err error
	prevRg := rg.Previous()
	if in.Cur, err = b.Overview(ctx, appID, rg); err != nil {
		return nil, err
	}
	if in.Prev, err = b.Overview(ctx, appID, prevRg); err != nil {
		return nil, err
	}
	cur, err := b.Visits(ctx, appID, rg)
	if err != nil {
		return nil, err
	}
	prev, err := b.Visits(ctx, appID, prevRg)
	if err != nil {
		return nil, err
	}
	in.SEO = BuildSEO(cur, prev, rg, tz)
	if in.Vitals, err = b.Vitals(ctx, appID, rg); err != nil {
		return nil, err
	}
	if in.EventsCur, err = b.Breakdown(ctx, appID, rg, "event", "", 100); err != nil {
		return nil, err
	}
	if in.EventsPrev, err = b.Breakdown(ctx, appID, prevRg, "event", "", 100); err != nil {
		return nil, err
	}
	// Nine calendar days ending today; drop today, which is not over yet.
	daily, err := b.Trend(ctx, appID, DaysRange(now, 9, tz), "", "day")
	if err != nil {
		return nil, err
	}
	if len(daily) > 0 {
		in.Daily = daily[:len(daily)-1]
	}
	return BuildInsights(in), nil
}
