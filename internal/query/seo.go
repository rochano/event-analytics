package query

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Traffic channels. A session's channel comes from its first event
// (first-touch), because later pageviews in the same visit carry the site's
// own address as referrer.
const (
	ChannelOrganic  = "Organic Search"
	ChannelAI       = "AI"
	ChannelSocial   = "Social"
	ChannelPaid     = "Paid"
	ChannelEmail    = "Email"
	ChannelReferral = "Referral"
	ChannelDirect   = "Direct"
)

// Channels lists every channel in display order.
var Channels = []string{ChannelOrganic, ChannelAI, ChannelSocial, ChannelReferral, ChannelPaid, ChannelEmail, ChannelDirect}

// Hosts (without "www.") that identify AI assistants, search engines and
// social networks. Matching is by suffix on a dot boundary, so
// "m.facebook.com" counts as facebook.com.
var (
	aiHosts = []string{"chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai",
		"gemini.google.com", "bard.google.com", "copilot.microsoft.com", "you.com", "phind.com",
		"poe.com", "chat.deepseek.com", "grok.com", "meta.ai", "chat.mistral.ai"}
	searchHosts = []string{"google.com", "google.co.th", "bing.com", "duckduckgo.com", "search.yahoo.com",
		"yahoo.com", "baidu.com", "yandex.ru", "yandex.com", "naver.com", "ecosia.org", "search.brave.com",
		"qwant.com", "sogou.com", "seznam.cz", "startpage.com"}
	socialHosts = []string{"facebook.com", "fb.com", "l.facebook.com", "lm.facebook.com", "instagram.com",
		"t.co", "x.com", "twitter.com", "line.me", "tiktok.com", "youtube.com", "youtu.be", "reddit.com",
		"linkedin.com", "lnkd.in", "pinterest.com", "discord.com", "threads.net", "messenger.com",
		"telegram.org", "t.me", "twitch.tv", "pantip.com"}
	aiSources     = []string{"chatgpt", "chatgpt.com", "openai", "perplexity", "claude", "gemini", "copilot"}
	socialSources = []string{"facebook", "fb", "instagram", "ig", "twitter", "x", "line", "tiktok", "youtube", "reddit", "linkedin", "discord", "threads"}
	paidMediums   = []string{"cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-social", "paid_social", "cpm", "ads", "display"}
)

func hostIs(host string, list []string) bool {
	host = strings.TrimPrefix(strings.ToLower(host), "www.")
	for _, h := range list {
		if host == h || strings.HasSuffix(host, "."+h) {
			return true
		}
	}
	return false
}

// isSearchHost also accepts country domains such as google.co.jp or bing.de.
func isSearchHost(host string) bool {
	if hostIs(host, searchHosts) {
		return true
	}
	host = strings.TrimPrefix(strings.ToLower(host), "www.")
	for _, p := range []string{"google.", "bing.", "yahoo.", "yandex."} {
		if strings.HasPrefix(host, p) || strings.Contains(host, "."+p) {
			return true
		}
	}
	return false
}

func in(v string, list []string) bool {
	v = strings.ToLower(v)
	for _, s := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Channel classifies a visit by its referrer host and UTM tags. AI is checked
// before search because gemini.google.com is also a Google host.
func Channel(referrer, utmSource, utmMedium string) string {
	ref := strings.ToLower(referrer)
	if ref == "$direct" {
		ref = ""
	}
	switch {
	case (ref != "" && hostIs(ref, aiHosts)) || in(utmSource, aiSources):
		return ChannelAI
	case in(utmMedium, paidMediums):
		return ChannelPaid
	case strings.EqualFold(utmMedium, "email") || in(utmSource, []string{"email", "newsletter"}):
		return ChannelEmail
	case ref != "" && isSearchHost(ref), strings.EqualFold(utmMedium, "organic"):
		return ChannelOrganic
	case (ref != "" && hostIs(ref, socialHosts)) || strings.EqualFold(utmMedium, "social") || in(utmSource, socialSources):
		return ChannelSocial
	case ref != "":
		return ChannelReferral
	case utmSource != "":
		return ChannelReferral
	}
	return ChannelDirect
}

// visitSource is what the dashboard shows as the source of a visit.
func visitSource(ref, utmSource string) string {
	if ref != "" && ref != "$direct" {
		return strings.TrimPrefix(strings.ToLower(ref), "www.")
	}
	if utmSource != "" {
		return strings.ToLower(utmSource)
	}
	return "(direct)"
}

// VisitRow is one group of sessions with the same day, landing page and
// first-touch source.
type VisitRow struct {
	Day       string
	Landing   string
	Referrer  string
	UTMSource string
	UTMMedium string
	Sessions  uint64
	Bounces   uint64
}

// Visits returns sessions that started in r, grouped by day, landing page and
// first-touch source. A bounce is a session with at most one pageview and no
// custom event (so a game session that fires stage_start is not a bounce).
func (s *Store) Visits(ctx context.Context, appID uint32, r Range) ([]VisitRow, error) {
	q := `
SELECT toString(toDate(start, {tz:String})) AS d, landing, ref, src, um, count(), countIf(bounced)
FROM (
    SELECT session_id,
           min(timestamp)                        AS start,
           argMin(pathname, timestamp)           AS landing,
           argMin(referrer_domain, timestamp)    AS ref,
           argMin(utm_source, timestamp)         AS src,
           argMin(utm_medium, timestamp)         AS um,
           countIf(event = '$pageview') <= 1 AND countIf(NOT startsWith(event, '$')) = 0 AS bounced
    FROM analytics.events
    WHERE app_id = {app_id:UInt32}
      AND timestamp >= toDateTime64({from:String}, 3) - INTERVAL 1 DAY AND timestamp < toDateTime64({to:String}, 3)
      AND session_id != '' AND event NOT IN ('$web_vitals', '$pageleave')
    GROUP BY session_id
    HAVING start >= toDateTime64({from:String}, 3)
)
GROUP BY d, landing, ref, src, um
LIMIT 100000`
	rows, err := s.conn.Query(s.ctx(ctx, appID, r.params()), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VisitRow
	for rows.Next() {
		var v VisitRow
		if err := rows.Scan(&v.Day, &v.Landing, &v.Referrer, &v.UTMSource, &v.UTMMedium, &v.Sessions, &v.Bounces); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ChannelStat is the visit count of one channel, with the previous period.
type ChannelStat struct {
	Channel    string  `json:"channel"`
	Sessions   uint64  `json:"sessions"`
	Previous   uint64  `json:"previous"`
	BounceRate float64 `json:"bounce_rate"`
}

// SourceStat is one referrer or utm_source.
type SourceStat struct {
	Source   string `json:"source"`
	Channel  string `json:"channel"`
	Sessions uint64 `json:"sessions"`
	Previous uint64 `json:"previous"`
}

// LandingStat is one landing page.
type LandingStat struct {
	Page       string  `json:"page"`
	Sessions   uint64  `json:"sessions"`
	Search     uint64  `json:"search"` // from Organic Search
	AI         uint64  `json:"ai"`
	BounceRate float64 `json:"bounce_rate"`
	Previous   uint64  `json:"previous"`
}

// ChannelPoint is one day of the per-channel trend.
type ChannelPoint struct {
	T        string            `json:"t"`
	Channels map[string]uint64 `json:"channels"`
}

// SEOReport is the SEO tab.
type SEOReport struct {
	Sessions uint64         `json:"sessions"`
	Previous uint64         `json:"previous"`
	Channels []ChannelStat  `json:"channels"`
	Trend    []ChannelPoint `json:"trend"`
	Sources  []SourceStat   `json:"sources"`
	Landing  []LandingStat  `json:"landing"`
}

// BuildSEO aggregates visit rows of the current and previous period.
func BuildSEO(cur, prev []VisitRow, r Range, tz string) SEOReport {
	var rep SEOReport
	ch := map[string]*ChannelStat{}
	chBounce := map[string]uint64{}
	for _, c := range Channels {
		ch[c] = &ChannelStat{Channel: c}
	}
	src := map[string]*SourceStat{}
	land := map[string]*LandingStat{}
	landBounce := map[string]uint64{}
	days := map[string]map[string]uint64{}
	for _, v := range cur {
		c := Channel(v.Referrer, v.UTMSource, v.UTMMedium)
		rep.Sessions += v.Sessions
		ch[c].Sessions += v.Sessions
		chBounce[c] += v.Bounces
		if days[v.Day] == nil {
			days[v.Day] = map[string]uint64{}
		}
		days[v.Day][c] += v.Sessions
		if c != ChannelDirect {
			k := visitSource(v.Referrer, v.UTMSource)
			if src[k] == nil {
				src[k] = &SourceStat{Source: k, Channel: c}
			}
			src[k].Sessions += v.Sessions
		}
		page := v.Landing
		if page == "" {
			page = "/"
		}
		if land[page] == nil {
			land[page] = &LandingStat{Page: page}
		}
		l := land[page]
		l.Sessions += v.Sessions
		landBounce[page] += v.Bounces
		switch c {
		case ChannelOrganic:
			l.Search += v.Sessions
		case ChannelAI:
			l.AI += v.Sessions
		}
	}
	for _, v := range prev {
		c := Channel(v.Referrer, v.UTMSource, v.UTMMedium)
		rep.Previous += v.Sessions
		ch[c].Previous += v.Sessions
		if c != ChannelDirect {
			if s := src[visitSource(v.Referrer, v.UTMSource)]; s != nil {
				s.Previous += v.Sessions
			}
		}
		page := v.Landing
		if page == "" {
			page = "/"
		}
		if l := land[page]; l != nil {
			l.Previous += v.Sessions
		}
	}
	for _, c := range Channels {
		st := ch[c]
		if st.Sessions > 0 {
			st.BounceRate = float64(chBounce[c]) / float64(st.Sessions)
		}
		rep.Channels = append(rep.Channels, *st)
	}
	for _, s := range src {
		rep.Sources = append(rep.Sources, *s)
	}
	sort.Slice(rep.Sources, func(i, j int) bool {
		if rep.Sources[i].Sessions != rep.Sources[j].Sessions {
			return rep.Sources[i].Sessions > rep.Sources[j].Sessions
		}
		return rep.Sources[i].Source < rep.Sources[j].Source
	})
	if len(rep.Sources) > 20 {
		rep.Sources = rep.Sources[:20]
	}
	for p, l := range land {
		if l.Sessions > 0 {
			l.BounceRate = float64(landBounce[p]) / float64(l.Sessions)
		}
		rep.Landing = append(rep.Landing, *l)
	}
	sort.Slice(rep.Landing, func(i, j int) bool {
		if rep.Landing[i].Sessions != rep.Landing[j].Sessions {
			return rep.Landing[i].Sessions > rep.Landing[j].Sessions
		}
		return rep.Landing[i].Page < rep.Landing[j].Page
	})
	if len(rep.Landing) > 25 {
		rep.Landing = rep.Landing[:25]
	}
	loc, _ := time.LoadLocation(tz)
	f := r.From.In(loc)
	for d := time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, loc); d.Before(r.To); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		pt := ChannelPoint{T: k, Channels: map[string]uint64{}}
		for _, c := range Channels {
			pt.Channels[c] = days[k][c]
		}
		rep.Trend = append(rep.Trend, pt)
	}
	return rep
}

// Core Web Vitals thresholds (Google): good at or below Good, poor above Poor.
var vitalThresholds = map[string][2]float64{
	"lcp": {2500, 4000}, "inp": {200, 500}, "cls": {0.1, 0.25}, "fcp": {1800, 3000}, "ttfb": {800, 1800},
}

// VitalNames is the display order.
var VitalNames = []string{"lcp", "inp", "cls", "fcp", "ttfb"}

// Rate returns "good", "needs-improvement" or "poor" for a p75 value.
func Rate(metric string, v float64) string {
	t, ok := vitalThresholds[metric]
	switch {
	case !ok:
		return ""
	case v <= t[0]:
		return "good"
	case v <= t[1]:
		return "needs-improvement"
	}
	return "poor"
}

// Vital is the 75th percentile of one metric (what Google uses).
type Vital struct {
	Metric  string  `json:"metric"`
	P75     float64 `json:"p75"`
	Rating  string  `json:"rating"`
	Samples uint64  `json:"samples"`
}

// VitalsGroup is the vitals of one device type or page.
type VitalsGroup struct {
	Key    string  `json:"key"`
	Views  uint64  `json:"views"`
	Vitals []Vital `json:"vitals"`
}

// VitalsReport is the Core Web Vitals section.
type VitalsReport struct {
	Overall  []Vital       `json:"overall"`
	ByDevice []VitalsGroup `json:"by_device"`
	ByPage   []VitalsGroup `json:"by_page"`
}

// Vitals returns p75 Core Web Vitals from $web_vitals events (sent by the SDK
// when a page is hidden), overall, by device type and for the busiest pages.
func (s *Store) Vitals(ctx context.Context, appID uint32, r Range) (VitalsReport, error) {
	var rep VitalsReport
	cols := make([]string, 0, 2*len(VitalNames))
	for _, m := range VitalNames {
		// Values are numbers in properties; anything else becomes NULL and is skipped.
		x := fmt.Sprintf("toFloat64OrNull(toString(properties.%s))", m)
		cols = append(cols, fmt.Sprintf("quantileIf(0.75)(%s, %s IS NOT NULL AND %s >= 0)", x, x, x), fmt.Sprintf("countIf(%s IS NOT NULL AND %s >= 0)", x, x))
	}
	base := `FROM analytics.events
WHERE app_id = {app_id:UInt32} AND timestamp >= toDateTime64({from:String}, 3) AND timestamp < toDateTime64({to:String}, 3)
  AND event = '$web_vitals'`
	scan := func(groupBy, order string, limit int) ([]VitalsGroup, error) {
		q := fmt.Sprintf("SELECT %s AS k, count(), %s %s GROUP BY k %s LIMIT %d", groupBy, strings.Join(cols, ", "), base, order, limit)
		rows, err := s.conn.Query(s.ctx(ctx, appID, r.params()), q)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []VitalsGroup
		for rows.Next() {
			var g VitalsGroup
			vals := make([]float64, len(VitalNames))
			counts := make([]uint64, len(VitalNames))
			dest := []any{&g.Key, &g.Views}
			for i := range VitalNames {
				dest = append(dest, &vals[i], &counts[i])
			}
			if err := rows.Scan(dest...); err != nil {
				return nil, err
			}
			for i, m := range VitalNames {
				if counts[i] == 0 || vals[i] != vals[i] { // no samples or NaN
					continue
				}
				g.Vitals = append(g.Vitals, Vital{Metric: m, P75: vals[i], Rating: Rate(m, vals[i]), Samples: counts[i]})
			}
			out = append(out, g)
		}
		return out, rows.Err()
	}
	all, err := scan("'all'", "", 1)
	if err != nil {
		return rep, err
	}
	if len(all) == 1 && all[0].Views > 0 {
		rep.Overall = all[0].Vitals
	}
	if rep.ByDevice, err = scan("device_type", "ORDER BY count() DESC", 5); err != nil {
		return rep, err
	}
	rep.ByPage, err = scan("pathname", "ORDER BY count() DESC", 10)
	return rep, err
}
