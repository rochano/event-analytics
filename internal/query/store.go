// Package query is the dashboard API: typed insight endpoints over ClickHouse.
package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Store runs tenant-scoped queries. Every query carries SQL_app_id, which the
// ClickHouse row policies require, and bound parameters (never string-built
// values), so a bug here cannot read another tenant's rows.
type Store struct {
	conn driver.Conn
	tz   string
}

// Open connects to ClickHouse over the native protocol.
func Open(addr, user, password, tz string) (*Store, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr:        []string{addr},
		Auth:        clickhouse.Auth{Database: "analytics", Username: user, Password: password},
		DialTimeout: 5 * time.Second,
		Settings:    clickhouse.Settings{"max_execution_time": 30},
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
	})
	if err != nil {
		return nil, err
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return nil, fmt.Errorf("bad timezone %q: %w", tz, err)
	}
	return &Store{conn: conn, tz: tz}, nil
}

// Ping checks connectivity.
func (s *Store) Ping(ctx context.Context) error { return s.conn.Ping(ctx) }

func (s *Store) ctx(ctx context.Context, appID uint32, params map[string]string) context.Context {
	p := map[string]string{"app_id": fmt.Sprint(appID), "tz": s.tz}
	for k, v := range params {
		p[k] = v
	}
	return clickhouse.Context(ctx,
		clickhouse.WithSettings(clickhouse.Settings{"SQL_app_id": clickhouse.CustomSetting{Value: fmt.Sprint(appID)}}),
		clickhouse.WithParameters(p),
	)
}

// Range is a half-open time window [From, To).
type Range struct{ From, To time.Time }

func (r Range) params() map[string]string {
	return map[string]string{
		"from": r.From.UTC().Format("2006-01-02 15:04:05"),
		"to":   r.To.UTC().Format("2006-01-02 15:04:05"),
	}
}

// DaysRange returns the last n calendar days in tz, ending now.
func DaysRange(now time.Time, n int, tz string) Range {
	loc, _ := time.LoadLocation(tz)
	l := now.In(loc)
	start := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -(n - 1))
	return Range{From: start, To: now}
}

// Previous returns the window of the same length right before r.
func (r Range) Previous() Range {
	d := r.To.Sub(r.From)
	return Range{From: r.From.Add(-d), To: r.From}
}

// KPIs for the overview header.
type KPIs struct {
	Visitors       uint64  `json:"visitors"`
	Pageviews      uint64  `json:"pageviews"`
	Events         uint64  `json:"events"`
	Sessions       uint64  `json:"sessions"`
	BounceRate     float64 `json:"bounce_rate"`
	AvgSessionSecs float64 `json:"avg_session_secs"`
}

// Overview returns KPIs for r. Visitors and pageviews come from the hourly
// rollup; sessions from the sessions rollup.
func (s *Store) Overview(ctx context.Context, appID uint32, r Range) (KPIs, error) {
	var k KPIs
	q := `
SELECT uniqCombined64Merge(users), sumIf(events, event = '$pageview'), sum(events)
FROM analytics.events_hourly
WHERE app_id = {app_id:UInt32} AND hour >= toStartOfHour(toDateTime({from:String})) AND hour < {to:DateTime}`
	if err := s.conn.QueryRow(s.ctx(ctx, appID, r.params()), q).Scan(&k.Visitors, &k.Pageviews, &k.Events); err != nil {
		return k, err
	}
	q = `
SELECT count(), countIf(pv <= 1) / greatest(count(), 1), avg(dateDiff('second', st, en))
FROM (
    SELECT session_id, min(start) AS st, max(end) AS en, sum(pageviews) AS pv
    FROM analytics.sessions
    WHERE app_id = {app_id:UInt32} AND day >= toDate(toDateTime({from:String})) AND day <= toDate(toDateTime({to:String}))
    GROUP BY session_id
    HAVING st >= toDateTime({from:String}) AND st < toDateTime({to:String})
)`
	var avg float64
	if err := s.conn.QueryRow(s.ctx(ctx, appID, r.params()), q).Scan(&k.Sessions, &k.BounceRate, &avg); err != nil {
		return k, err
	}
	if avg == avg { // not NaN
		k.AvgSessionSecs = avg
	}
	return k, nil
}

// Point is one bucket of a time series.
type Point struct {
	T      string `json:"t"`
	Events uint64 `json:"events"`
	Users  uint64 `json:"users"`
}

// Trend returns per-day (or per-hour) counts for one event ("" = all events).
func (s *Store) Trend(ctx context.Context, appID uint32, r Range, event, interval string) ([]Point, error) {
	bucket := "toString(toDate(hour, {tz:String}))"
	if interval == "hour" {
		bucket = "formatDateTime(toTimeZone(hour, {tz:String}), '%Y-%m-%d %H:00')"
	}
	q := fmt.Sprintf(`
SELECT %s AS t, sum(events), uniqCombined64Merge(users)
FROM analytics.events_hourly
WHERE app_id = {app_id:UInt32} AND hour >= toStartOfHour(toDateTime({from:String})) AND hour < {to:DateTime}
  AND ({event:String} = '' OR event = {event:String})
GROUP BY t ORDER BY t`, bucket)
	p := r.params()
	p["event"] = event
	rows, err := s.conn.Query(s.ctx(ctx, appID, p), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	got := map[string]Point{}
	for rows.Next() {
		var pt Point
		if err := rows.Scan(&pt.T, &pt.Events, &pt.Users); err != nil {
			return nil, err
		}
		got[pt.T] = pt
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return fillSeries(got, r, interval, s.tz), nil
}

// fillSeries returns one point per bucket, zeros included, so charts do not
// draw a straight line across days with no data.
func fillSeries(got map[string]Point, r Range, interval, tz string) []Point {
	loc, _ := time.LoadLocation(tz)
	var out []Point
	if interval == "hour" {
		for t := r.From.In(loc).Truncate(time.Hour); t.Before(r.To); t = t.Add(time.Hour) {
			k := t.Format("2006-01-02 15:00")
			p := got[k]
			p.T = k
			out = append(out, p)
		}
		return out
	}
	f := r.From.In(loc)
	for d := time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, loc); d.Before(r.To); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		p := got[k]
		p.T = k
		out = append(out, p)
	}
	return out
}

// Dimensions a breakdown may group by (identifiers, never user input).
var Dimensions = map[string]string{
	"pathname": "pathname", "referrer_domain": "referrer_domain", "utm_source": "utm_source",
	"country_code": "country_code", "device_type": "device_type", "browser": "browser", "event": "event",
}

// Row is one breakdown row.
type Row struct {
	Value  string `json:"value"`
	Events uint64 `json:"events"`
	Users  uint64 `json:"users"`
}

// Breakdown returns the top values of a dimension.
func (s *Store) Breakdown(ctx context.Context, appID uint32, r Range, dim, event string, limit int) ([]Row, error) {
	col, ok := Dimensions[dim]
	if !ok {
		return nil, fmt.Errorf("unknown dimension %q", dim)
	}
	q := fmt.Sprintf(`
SELECT %s AS v, sum(events) AS e, uniqCombined64Merge(users) AS u
FROM analytics.events_hourly
WHERE app_id = {app_id:UInt32} AND hour >= toStartOfHour(toDateTime({from:String})) AND hour < {to:DateTime}
  AND ({event:String} = '' OR event = {event:String})
GROUP BY v ORDER BY e DESC LIMIT %d`, col, limit) // limit is a validated int
	p := r.params()
	p["event"] = event
	rows, err := s.conn.Query(s.ctx(ctx, appID, p), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var row Row
		if err := rows.Scan(&row.Value, &row.Events, &row.Users); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// FunnelStep is one step's result.
type FunnelStep struct {
	Event string `json:"event"`
	Users uint64 `json:"users"`
}

// Funnel counts users who did steps in order within window seconds,
// using ClickHouse's windowFunnel on raw events.
func (s *Store) Funnel(ctx context.Context, appID uint32, r Range, steps []string, window int) ([]FunnelStep, error) {
	if len(steps) < 2 || len(steps) > 8 {
		return nil, fmt.Errorf("funnel needs 2 to 8 steps")
	}
	p := r.params()
	conds := make([]string, len(steps))
	ins := make([]string, len(steps))
	for i, st := range steps {
		name := fmt.Sprintf("s%d", i)
		p[name] = st
		conds[i] = fmt.Sprintf("event = {%s:String}", name)
		ins[i] = fmt.Sprintf("{%s:String}", name)
	}
	p["window"] = fmt.Sprint(window)
	q := fmt.Sprintf(`
SELECT level, count()
FROM (
    SELECT person_id, windowFunnel({window:UInt64})(toDateTime(timestamp), %s) AS level
    FROM analytics.events
    WHERE app_id = {app_id:UInt32} AND timestamp >= toDateTime64({from:String}, 3) AND timestamp < toDateTime64({to:String}, 3)
      AND event IN (%s)
    GROUP BY person_id
)
WHERE level > 0
GROUP BY level`, strings.Join(conds, ", "), strings.Join(ins, ", "))
	rows, err := s.conn.Query(s.ctx(ctx, appID, p), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	atLevel := make([]uint64, len(steps)+1)
	for rows.Next() {
		var lvl uint8
		var n uint64
		if err := rows.Scan(&lvl, &n); err != nil {
			return nil, err
		}
		if int(lvl) < len(atLevel) {
			atLevel[lvl] = n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]FunnelStep, len(steps))
	var cum uint64
	for i := len(steps); i >= 1; i-- {
		cum += atLevel[i] // reached step i = finished at level >= i
		out[i-1] = FunnelStep{Event: steps[i-1], Users: cum}
	}
	return out, nil
}

// Cohort is one row of the retention grid.
type Cohort struct {
	Week  string   `json:"week"`
	Size  uint64   `json:"size"`
	Users []uint64 `json:"users"` // users active in week 0..n
}

// Retention returns weekly cohorts by first-seen week, from user_days.
func (s *Store) Retention(ctx context.Context, appID uint32, now time.Time, weeks int) ([]Cohort, error) {
	loc, _ := time.LoadLocation(s.tz)
	l := now.In(loc)
	monday := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
	for monday.Weekday() != time.Monday {
		monday = monday.AddDate(0, 0, -1)
	}
	from := monday.AddDate(0, 0, -7*(weeks-1))
	p := map[string]string{"from_day": from.Format("2006-01-02"), "weeks": fmt.Sprint(weeks)}
	q := `
WITH cohort AS (
    SELECT person_id, toMonday(toDate(min(first_seen), {tz:String})) AS cw
    FROM analytics.user_days
    WHERE app_id = {app_id:UInt32}
    GROUP BY person_id
    HAVING cw >= toDate({from_day:String})
)
SELECT toString(c.cw) AS w, dateDiff('week', c.cw, toMonday(u.day)) AS n, uniqExact(u.person_id)
FROM analytics.user_days AS u
INNER JOIN cohort AS c USING (person_id)
WHERE u.app_id = {app_id:UInt32} AND u.day >= toDate({from_day:String})
GROUP BY w, n
HAVING n >= 0 AND n < {weeks:UInt32}
ORDER BY w, n`
	rows, err := s.conn.Query(s.ctx(ctx, appID, p), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byWeek := map[string][]uint64{}
	for rows.Next() {
		var w string
		var n int64
		var users uint64
		if err := rows.Scan(&w, &n, &users); err != nil {
			return nil, err
		}
		if byWeek[w] == nil {
			byWeek[w] = make([]uint64, weeks)
		}
		byWeek[w][n] = users
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []Cohort
	for i := 0; i < weeks; i++ {
		w := from.AddDate(0, 0, 7*i).Format("2006-01-02")
		cells := byWeek[w]
		if cells == nil {
			cells = make([]uint64, weeks)
		}
		visible := weeks - i // future weeks are not known yet
		out = append(out, Cohort{Week: w, Size: cells[0], Users: cells[:visible]})
	}
	return out, nil
}

// LiveEvent is one row of the live feed.
type LiveEvent struct {
	Timestamp  time.Time `json:"timestamp"`
	Event      string    `json:"event"`
	DistinctID string    `json:"distinct_id"`
	Pathname   string    `json:"pathname"`
	Country    string    `json:"country"`
	Device     string    `json:"device"`
	Properties string    `json:"properties"`
}

// Live returns the most recent events.
func (s *Store) Live(ctx context.Context, appID uint32, limit int) ([]LiveEvent, error) {
	q := `
SELECT timestamp, event, distinct_id, pathname, country_code, device_type, toJSONString(properties)
FROM analytics.events
WHERE app_id = {app_id:UInt32} AND timestamp > now() - INTERVAL 1 DAY
ORDER BY timestamp DESC
LIMIT ` + fmt.Sprint(limit) // limit is a validated int
	rows, err := s.conn.Query(s.ctx(ctx, appID, nil), q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LiveEvent
	for rows.Next() {
		var e LiveEvent
		if err := rows.Scan(&e.Timestamp, &e.Event, &e.DistinctID, &e.Pathname, &e.Country, &e.Device, &e.Properties); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ActiveNow counts distinct users seen in the last 5 minutes.
func (s *Store) ActiveNow(ctx context.Context, appID uint32) (uint64, error) {
	var n uint64
	q := `SELECT uniq(distinct_id) FROM analytics.events
WHERE app_id = {app_id:UInt32} AND toDate(timestamp) >= yesterday() AND timestamp > now() - INTERVAL 5 MINUTE`
	err := s.conn.QueryRow(s.ctx(ctx, appID, nil), q).Scan(&n)
	return n, err
}

// EventNames lists event names seen in r, most frequent first.
func (s *Store) EventNames(ctx context.Context, appID uint32, r Range) ([]Row, error) {
	return s.Breakdown(ctx, appID, r, "event", "", 100)
}
