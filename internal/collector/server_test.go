package collector

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rochano/event-analytics/internal/config"
	"github.com/rochano/event-analytics/internal/spool"
)

type memSink struct {
	mu   sync.Mutex
	recs map[string][]spool.Record
}

func (m *memSink) Enqueue(topic string, r spool.Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.recs == nil {
		m.recs = map[string][]spool.Record{}
	}
	m.recs[topic] = append(m.recs[topic], r)
	return nil
}
func (m *memSink) Ready() bool { return true }

var fixedNow = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)

func newTestServer(t *testing.T, origins ...string) (*Server, *memSink) {
	t.Helper()
	sink := &memSink{}
	s := NewServer(Options{
		Projects: []config.Project{{AppID: 7, WriteKey: "pk_test", RatePerSec: 100, Burst: 5, RetentionDays: 90, AllowedOrigins: origins}},
		Sink:     sink, Topic: "events.raw", DLQTopic: "events.dlq",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	s.now = func() time.Time { return fixedNow }
	return s, sink
}

func post(t *testing.T, h http.Handler, body string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/e", strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAcceptsBatchAndEnriches(t *testing.T) {
	s, sink := newTestServer(t)
	body := `[{"event":"$pageview","distinct_id":"u1","timestamp":"2026-11-11T11:59:00Z",
	  "properties":{"$current_url":"https://shop.example.com/sale?utm_source=line","$referrer":"https://www.google.com/search"}},
	  {"event":"level_complete","distinct_id":"p9","properties":{"level_id":"w1_s3","stars":3}}]`
	rec := post(t, s.Handler(), body, map[string]string{
		"X-Api-Key": "pk_test", "CF-IPCountry": "th",
		"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got := sink.recs["events.raw"]
	if len(got) != 2 {
		t.Fatalf("want 2 records, got %d", len(got))
	}
	var e OutEvent
	if err := json.Unmarshal(got[0].Value, &e); err != nil {
		t.Fatal(err)
	}
	if e.AppID != 7 || e.Pathname != "/sale" || e.UTMSource != "line" || e.ReferrerDomain != "google.com" ||
		e.CountryCode != "TH" || e.DeviceType != "Mobile" || e.OS != "iOS" || e.RetentionDays != 90 ||
		e.Timestamp != "2026-11-11 11:59:00.000" || e.EventUUID == "" || got[0].Key != "7:u1" {
		t.Fatalf("unexpected enrichment: %+v key=%s", e, got[0].Key)
	}
	var e2 OutEvent
	_ = json.Unmarshal(got[1].Value, &e2)
	if e2.Timestamp != "2026-11-11 12:00:00.000" || !strings.Contains(e2.Properties, `"stars":3`) {
		t.Fatalf("second event: %+v", e2)
	}
}

func TestEnvelopeKeyInBodyAndGzip(t *testing.T) {
	s, sink := newTestServer(t)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	_, _ = gz.Write([]byte(`{"api_key":"pk_test","sent_at":"2026-11-11T11:00:00Z","batch":[{"event":"a","distinct_id":"x","timestamp":"2026-11-11T10:59:00Z"}]}`))
	_ = gz.Close()
	req := httptest.NewRequest(http.MethodPost, "/e", &buf)
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var e OutEvent
	_ = json.Unmarshal(sink.recs["events.raw"][0].Value, &e)
	// Device clock was 1h behind: 10:59 + (12:00 - 11:00) = 11:59.
	if e.Timestamp != "2026-11-11 11:59:00.000" {
		t.Fatalf("clock skew not corrected: %s", e.Timestamp)
	}
}

func TestInvalidEventsGoToDLQ(t *testing.T) {
	s, sink := newTestServer(t)
	body := `[{"event":"","distinct_id":"x"},{"event":"old","distinct_id":"x","timestamp":"2026-10-01T00:00:00Z"},{"event":"ok","distinct_id":"x"}]`
	rec := post(t, s.Handler(), body, map[string]string{"X-Api-Key": "pk_test"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	if len(sink.recs["events.raw"]) != 1 || len(sink.recs["events.dlq"]) != 2 {
		t.Fatalf("raw=%d dlq=%d", len(sink.recs["events.raw"]), len(sink.recs["events.dlq"]))
	}
}

func TestRejections(t *testing.T) {
	s, _ := newTestServer(t)
	h := s.Handler()
	if c := post(t, h, `[{"event":"a","distinct_id":"x"}]`, nil).Code; c != http.StatusUnauthorized {
		t.Fatalf("no key: %d", c)
	}
	if c := post(t, h, `not json`, map[string]string{"X-Api-Key": "pk_test"}).Code; c != http.StatusBadRequest {
		t.Fatalf("bad json: %d", c)
	}
	if c := post(t, h, `[]`, map[string]string{"X-Api-Key": "pk_test"}).Code; c != http.StatusBadRequest {
		t.Fatalf("empty batch: %d", c)
	}
	big := `[` + strings.Repeat(`{"event":"a","distinct_id":"x"},`, 100) + `{"event":"a","distinct_id":"x"}]`
	if c := post(t, h, big, map[string]string{"X-Api-Key": "pk_test"}).Code; c != http.StatusBadRequest {
		t.Fatalf("101 events: %d", c)
	}
}

func TestRateLimit(t *testing.T) {
	s, _ := newTestServer(t) // burst 5
	h := s.Handler()
	batch := `[` + strings.Repeat(`{"event":"a","distinct_id":"x"},`, 3) + `{"event":"a","distinct_id":"x"}]` // 4 events
	if c := post(t, h, batch, map[string]string{"X-Api-Key": "pk_test"}).Code; c != http.StatusNoContent {
		t.Fatalf("first: %d", c)
	}
	rec := post(t, h, batch, map[string]string{"X-Api-Key": "pk_test"})
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("second: %d retry-after=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestCORS(t *testing.T) {
	s, sink := newTestServer(t, "https://shop.example.com")
	h := s.Handler()

	req := httptest.NewRequest(http.MethodOptions, "/e", nil)
	req.Header.Set("Origin", "https://shop.example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Max-Age") != "86400" {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}

	rec = post(t, h, `[{"event":"a","distinct_id":"x"}]`, map[string]string{"X-Api-Key": "pk_test", "Origin": "https://shop.example.com"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://shop.example.com" {
		t.Fatalf("allowed origin not echoed: %v", rec.Header())
	}
	rec = post(t, h, `[{"event":"a","distinct_id":"x"}]`, map[string]string{"X-Api-Key": "pk_test", "Origin": "https://evil.example"})
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign origin: %d %v", rec.Code, rec.Header())
	}
	if len(sink.recs["events.raw"]) != 1 {
		t.Fatalf("foreign-origin events must be dropped, got %d", len(sink.recs["events.raw"]))
	}
}

func TestPersonIDStable(t *testing.T) {
	a, b := PersonID(1, "u"), PersonID(1, "u")
	if a != b || a == PersonID(2, "u") || len(a) != 36 || a[14] != '5' {
		t.Fatalf("person id: %s %s", a, b)
	}
	if u := UUIDv7(); len(u) != 36 || u[14] != '7' {
		t.Fatalf("uuidv7: %s", u)
	}
}
