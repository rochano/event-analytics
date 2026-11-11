package query

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rochano/event-analytics/internal/config"
	"golang.org/x/sync/singleflight"
)

// Backend is what the API needs from storage (Store implements it).
type Backend interface {
	Overview(ctx context.Context, appID uint32, r Range) (KPIs, error)
	Trend(ctx context.Context, appID uint32, r Range, event, interval string) ([]Point, error)
	Breakdown(ctx context.Context, appID uint32, r Range, dim, event string, limit int) ([]Row, error)
	Funnel(ctx context.Context, appID uint32, r Range, steps []string, window int) ([]FunnelStep, error)
	Retention(ctx context.Context, appID uint32, now time.Time, weeks int) ([]Cohort, error)
	Live(ctx context.Context, appID uint32, limit int) ([]LiveEvent, error)
	ActiveNow(ctx context.Context, appID uint32) (uint64, error)
	EventNames(ctx context.Context, appID uint32, r Range) ([]Row, error)
}

// API serves /api/* and the static dashboard.
type API struct {
	backend   Backend
	projects  []config.Project
	tz        string
	collector string
	log       *slog.Logger
	now       func() time.Time

	cache *ttlCache
	group singleflight.Group
}

// NewAPI builds the handler set.
func NewAPI(b Backend, projects []config.Project, tz, collectorURL string, log *slog.Logger) *API {
	return &API{backend: b, projects: projects, tz: tz, collector: collectorURL, log: log, now: time.Now, cache: newTTLCache(10000)}
}

// Handler returns the routes. webDir may be "" to skip the dashboard.
func (a *API) Handler(webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/api/config", a.auth(a.config))
	mux.HandleFunc("/api/overview", a.auth(a.cached(60*time.Second, a.overview)))
	mux.HandleFunc("/api/trend", a.auth(a.cached(60*time.Second, a.trend)))
	mux.HandleFunc("/api/breakdown", a.auth(a.cached(60*time.Second, a.breakdown)))
	mux.HandleFunc("/api/events", a.auth(a.cached(5*time.Minute, a.eventNames)))
	mux.HandleFunc("/api/funnel", a.auth(a.cached(2*time.Minute, a.funnel)))
	mux.HandleFunc("/api/retention", a.auth(a.cached(10*time.Minute, a.retention)))
	mux.HandleFunc("/api/live", a.auth(a.cached(3*time.Second, a.live)))
	if webDir != "" {
		mux.Handle("/", http.FileServer(http.Dir(webDir)))
	}
	return mux
}

type handlerFunc func(r *http.Request, p config.Project) (any, error)

type ctxKey struct{}

// auth resolves the tenant from the read key. The tenant always comes from
// the key, never from a request parameter.
func (a *API) auth(next func(http.ResponseWriter, *http.Request, config.Project)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("X-Read-Key")
		if key == "" {
			key = r.URL.Query().Get("key")
		}
		for _, p := range a.projects {
			if p.ReadKey != "" && subtle.ConstantTimeCompare([]byte(p.ReadKey), []byte(key)) == 1 {
				next(w, r, p)
				return
			}
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid read key"})
	}
}

// cached serves repeated identical requests from memory and collapses
// concurrent identical requests into one ClickHouse query.
func (a *API) cached(ttl time.Duration, h handlerFunc) func(http.ResponseWriter, *http.Request, config.Project) {
	return func(w http.ResponseWriter, r *http.Request, p config.Project) {
		q := r.URL.Query()
		q.Del("key")
		ck := strconv.FormatUint(uint64(p.AppID), 10) + "|" + r.URL.Path + "?" + q.Encode()
		if v, ok := a.cache.get(ck); ok {
			w.Header().Set("X-Cache", "hit")
			writeRaw(w, v)
			return
		}
		v, err, _ := a.group.Do(ck, func() (any, error) {
			res, err := h(r, p)
			if err != nil {
				return nil, err
			}
			b, err := json.Marshal(map[string]any{"data": res, "computed_at": a.now().UTC()})
			if err != nil {
				return nil, err
			}
			a.cache.set(ck, b, ttl)
			return b, nil
		})
		if err != nil {
			var bad badRequest
			if errors.As(err, &bad) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": bad.Error()})
				return
			}
			a.log.Error("query failed", "path", r.URL.Path, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
			return
		}
		w.Header().Set("X-Cache", "miss")
		writeRaw(w, v.([]byte))
	}
}

type badRequest struct{ msg string }

func (b badRequest) Error() string { return b.msg }

func (a *API) days(r *http.Request) (Range, error) {
	n := 30
	if s := r.URL.Query().Get("days"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 || v > 400 {
			return Range{}, badRequest{"days must be 1..400"}
		}
		n = v
	}
	return DaysRange(a.now(), n, a.tz), nil
}

func (a *API) config(w http.ResponseWriter, _ *http.Request, p config.Project) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app_id": p.AppID, "write_key": p.WriteKey, "collector_url": a.collector, "timezone": a.tz,
	})
}

func (a *API) overview(r *http.Request, p config.Project) (any, error) {
	rg, err := a.days(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	cur, err := a.backend.Overview(ctx, p.AppID, rg)
	if err != nil {
		return nil, err
	}
	prev, err := a.backend.Overview(ctx, p.AppID, rg.Previous())
	if err != nil {
		return nil, err
	}
	active, err := a.backend.ActiveNow(ctx, p.AppID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"current": cur, "previous": prev, "active_now": active}, nil
}

func (a *API) trend(r *http.Request, p config.Project) (any, error) {
	rg, err := a.days(r)
	if err != nil {
		return nil, err
	}
	interval := r.URL.Query().Get("interval")
	if interval != "hour" {
		interval = "day"
	}
	return a.backend.Trend(r.Context(), p.AppID, rg, r.URL.Query().Get("event"), interval)
}

func (a *API) breakdown(r *http.Request, p config.Project) (any, error) {
	rg, err := a.days(r)
	if err != nil {
		return nil, err
	}
	dim := r.URL.Query().Get("dim")
	if _, ok := Dimensions[dim]; !ok {
		return nil, badRequest{"unknown dim"}
	}
	limit := 10
	if s := r.URL.Query().Get("limit"); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 100 {
			limit = v
		}
	}
	return a.backend.Breakdown(r.Context(), p.AppID, rg, dim, r.URL.Query().Get("event"), limit)
}

func (a *API) eventNames(r *http.Request, p config.Project) (any, error) {
	rg, err := a.days(r)
	if err != nil {
		return nil, err
	}
	return a.backend.EventNames(r.Context(), p.AppID, rg)
}

func (a *API) funnel(r *http.Request, p config.Project) (any, error) {
	rg, err := a.days(r)
	if err != nil {
		return nil, err
	}
	var steps []string
	for _, s := range strings.Split(r.URL.Query().Get("steps"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			steps = append(steps, s)
		}
	}
	if len(steps) < 2 || len(steps) > 8 {
		return nil, badRequest{"steps: give 2 to 8 comma-separated event names"}
	}
	window := 86400
	if s := r.URL.Query().Get("window"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 60 || v > 30*86400 {
			return nil, badRequest{"window must be 60..2592000 seconds"}
		}
		window = v
	}
	return a.backend.Funnel(r.Context(), p.AppID, rg, steps, window)
}

func (a *API) retention(r *http.Request, p config.Project) (any, error) {
	weeks := 8
	if s := r.URL.Query().Get("weeks"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 2 || v > 26 {
			return nil, badRequest{"weeks must be 2..26"}
		}
		weeks = v
	}
	return a.backend.Retention(r.Context(), p.AppID, a.now(), weeks)
}

func (a *API) live(r *http.Request, p config.Project) (any, error) {
	limit := 30
	if s := r.URL.Query().Get("limit"); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 200 {
			limit = v
		}
	}
	evs, err := a.backend.Live(r.Context(), p.AppID, limit)
	if err != nil {
		return nil, err
	}
	active, err := a.backend.ActiveNow(r.Context(), p.AppID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"events": evs, "active_now": active}, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRaw(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

// ttlCache is a small in-process result cache. In a multi-pod deployment put
// Redis behind the same interface (docs/architecture.md section 5).
type ttlCache struct {
	mu    sync.Mutex
	max   int
	items map[string]cacheItem
}

type cacheItem struct {
	v   []byte
	exp time.Time
}

func newTTLCache(max int) *ttlCache { return &ttlCache{max: max, items: map[string]cacheItem{}} }

func (c *ttlCache) get(k string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	it, ok := c.items[k]
	if !ok || time.Now().After(it.exp) {
		return nil, false
	}
	return it.v, true
}

func (c *ttlCache) set(k string, v []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.items) >= c.max {
		now := time.Now()
		for key, it := range c.items {
			if now.After(it.exp) {
				delete(c.items, key)
			}
		}
		if len(c.items) >= c.max {
			c.items = map[string]cacheItem{}
		}
	}
	c.items[k] = cacheItem{v: v, exp: time.Now().Add(ttl)}
}
