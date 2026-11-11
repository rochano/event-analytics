package query

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rochano/event-analytics/internal/config"
)

type fakeBackend struct {
	calls     atomic.Int64
	lastApp   uint32
	lastSteps []string
}

func (f *fakeBackend) Overview(_ context.Context, app uint32, _ Range) (KPIs, error) {
	f.calls.Add(1)
	f.lastApp = app
	return KPIs{Visitors: 10, Pageviews: 30}, nil
}
func (f *fakeBackend) Trend(context.Context, uint32, Range, string, string) ([]Point, error) {
	return []Point{{T: "2026-11-11", Events: 5}}, nil
}
func (f *fakeBackend) Breakdown(context.Context, uint32, Range, string, string, int) ([]Row, error) {
	return []Row{{Value: "/", Events: 3}}, nil
}
func (f *fakeBackend) Funnel(_ context.Context, _ uint32, _ Range, steps []string, _ int) ([]FunnelStep, error) {
	f.lastSteps = steps
	return []FunnelStep{{Event: steps[0], Users: 10}, {Event: steps[1], Users: 4}}, nil
}
func (f *fakeBackend) Retention(context.Context, uint32, time.Time, int) ([]Cohort, error) {
	return nil, nil
}
func (f *fakeBackend) Live(context.Context, uint32, int) ([]LiveEvent, error)   { return nil, nil }
func (f *fakeBackend) ActiveNow(context.Context, uint32) (uint64, error)        { return 2, nil }
func (f *fakeBackend) EventNames(context.Context, uint32, Range) ([]Row, error) { return nil, nil }

func newTestAPI() (*API, *fakeBackend) {
	fb := &fakeBackend{}
	api := NewAPI(fb, []config.Project{{AppID: 1, WriteKey: "pk1", ReadKey: "rk1"}, {AppID: 2, WriteKey: "pk2", ReadKey: "rk2"}},
		"Asia/Bangkok", "http://localhost:8080", slog.New(slog.NewTextHandler(io.Discard, nil)))
	return api, fb
}

func get(h http.Handler, path, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if key != "" {
		req.Header.Set("X-Read-Key", key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuthResolvesTenantFromKey(t *testing.T) {
	api, fb := newTestAPI()
	h := api.Handler("")
	if c := get(h, "/api/overview", "").Code; c != http.StatusUnauthorized {
		t.Fatalf("no key: %d", c)
	}
	if c := get(h, "/api/overview", "nope").Code; c != http.StatusUnauthorized {
		t.Fatalf("bad key: %d", c)
	}
	// An app_id parameter must not override the key's tenant.
	rec := get(h, "/api/overview?app_id=1", "rk2")
	if rec.Code != http.StatusOK || fb.lastApp != 2 {
		t.Fatalf("code=%d app=%d", rec.Code, fb.lastApp)
	}
}

func TestCacheAndValidation(t *testing.T) {
	api, fb := newTestAPI()
	h := api.Handler("")
	r1 := get(h, "/api/overview?days=7", "rk1")
	r2 := get(h, "/api/overview?days=7", "rk1")
	if r1.Header().Get("X-Cache") != "miss" || r2.Header().Get("X-Cache") != "hit" {
		t.Fatalf("cache headers: %q %q", r1.Header().Get("X-Cache"), r2.Header().Get("X-Cache"))
	}
	if fb.calls.Load() != 2 { // current + previous period, once
		t.Fatalf("backend calls = %d", fb.calls.Load())
	}
	get(h, "/api/overview?days=7", "rk2")
	if fb.calls.Load() != 4 {
		t.Fatal("cache must be per tenant")
	}
	if c := get(h, "/api/overview?days=999", "rk1").Code; c != http.StatusBadRequest {
		t.Fatalf("days=999: %d", c)
	}
	if c := get(h, "/api/breakdown?dim=password", "rk1").Code; c != http.StatusBadRequest {
		t.Fatalf("bad dim: %d", c)
	}
	if c := get(h, "/api/funnel?steps=a", "rk1").Code; c != http.StatusBadRequest {
		t.Fatalf("one step: %d", c)
	}
	rec := get(h, "/api/funnel?steps=view,%20buy", "rk1")
	var body struct {
		Data []FunnelStep `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 200 || len(body.Data) != 2 || fb.lastSteps[1] != "buy" {
		t.Fatalf("funnel: %d %s", rec.Code, rec.Body)
	}
}

func TestDaysRangeAndFill(t *testing.T) {
	now := time.Date(2026, 11, 11, 15, 0, 0, 0, time.UTC) // 22:00 in Bangkok
	r := DaysRange(now, 7, "Asia/Bangkok")
	if got := r.From.Format("2006-01-02 15:04 MST"); got != "2026-11-05 00:00 +07" {
		t.Fatalf("from = %s", got)
	}
	pts := fillSeries(map[string]Point{"2026-11-07": {T: "2026-11-07", Events: 9}}, r, "day", "Asia/Bangkok")
	if len(pts) != 7 || pts[2].Events != 9 || pts[0].T != "2026-11-05" || pts[6].T != "2026-11-11" {
		t.Fatalf("fill: %+v", pts)
	}
}
