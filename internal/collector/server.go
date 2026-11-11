// Package collector is the ingestion HTTP service: validate, enqueue, 204.
package collector

import (
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rochano/event-analytics/internal/config"
	"github.com/rochano/event-analytics/internal/ratelimit"
	"github.com/rochano/event-analytics/internal/spool"
)

const (
	maxCompressedBody   = 512 << 10
	maxDecompressedBody = 2 << 20
)

// Server handles /e, /healthz, /readyz and /metrics.
type Server struct {
	byKey   map[string]config.Project
	limiter *ratelimit.Limiter
	sink    Sink
	topic   string
	dlq     string
	log     *slog.Logger
	now     func() time.Time
	newUUID func() string

	requests    atomic.Int64
	accepted    atomic.Int64
	invalid     atomic.Int64
	rateLimited atomic.Int64
	rejected    atomic.Int64
}

// Options for NewServer.
type Options struct {
	Projects []config.Project
	Sink     Sink
	Topic    string // events topic
	DLQTopic string // invalid events go here with a reason
	Log      *slog.Logger
}

// NewServer builds the collector.
func NewServer(o Options) *Server {
	byKey := make(map[string]config.Project, len(o.Projects))
	for _, p := range o.Projects {
		byKey[p.WriteKey] = p
	}
	return &Server{
		byKey: byKey, limiter: ratelimit.New(), sink: o.Sink, topic: o.Topic, dlq: o.DLQTopic,
		log: o.Log, now: time.Now, newUUID: UUIDv7,
	}
}

// Handler returns the HTTP routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/e", s.handleEvents)
	mux.HandleFunc("/e/", s.handleEvents)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !s.sink.Ready() {
			http.Error(w, "spool nearly full", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/metrics", s.handleMetrics)
	return mux
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		// Preflight: we do not know the tenant yet, so allow and cache it.
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", originOrStar(r))
		h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Content-Encoding, X-Api-Key")
		h.Set("Access-Control-Max-Age", "86400")
		h.Add("Vary", "Origin")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.requests.Add(1)
	received := s.now()

	body, err := readBody(w, r)
	if err != nil {
		s.rejected.Add(1)
		status := http.StatusBadRequest
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) || errors.Is(err, errTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		http.Error(w, err.Error(), status)
		return
	}
	events, bodyKey, sentAt, err := ParseBatch(body)
	if err != nil {
		s.rejected.Add(1)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	key := r.Header.Get("X-Api-Key")
	if key == "" {
		key = r.URL.Query().Get("k")
	}
	if key == "" {
		key = bodyKey
	}
	proj, ok := s.byKey[key]
	if !ok {
		s.rejected.Add(1)
		http.Error(w, "unknown project key", http.StatusUnauthorized)
		return
	}

	origin := r.Header.Get("Origin")
	originOK := origin == "" || allowed(proj.AllowedOrigins, origin)
	if origin != "" && originOK {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}

	if len(events) == 0 || len(events) > MaxEventsPerBatch {
		s.rejected.Add(1)
		http.Error(w, fmt.Sprintf("batch must hold 1 to %d events", MaxEventsPerBatch), http.StatusBadRequest)
		return
	}
	if !s.limiter.AllowN(proj.AppID, len(events), proj.RatePerSec, proj.Burst) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "2")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !originOK {
		// Answer like success so scrapers learn nothing; drop the events.
		s.invalid.Add(int64(len(events)))
		w.WriteHeader(http.StatusNoContent)
		return
	}

	meta := RequestMeta{
		ReceivedAt: received,
		UserAgent:  r.UserAgent(),
		Country:    firstNonEmpty(r.Header.Get("CF-IPCountry"), r.Header.Get("X-Country")),
		Region:     r.Header.Get("X-Region"),
		City:       r.Header.Get("X-City"),
	}
	if sentAt == "" {
		sentAt = r.URL.Query().Get("sent_at")
	}
	if sentAt != "" {
		if t, err := time.Parse(time.RFC3339Nano, sentAt); err == nil {
			meta.SentAt = t
		}
	}

	for _, in := range events {
		out, err := Normalize(in, proj.AppID, proj.RetentionDays, meta, s.newUUID)
		if err != nil {
			s.invalid.Add(1)
			s.toDLQ(proj.AppID, in, err)
			continue
		}
		val, _ := json.Marshal(out)
		if err := s.sink.Enqueue(s.topic, spool.Record{Key: fmt.Sprintf("%d:%s", proj.AppID, in.DistinctID), Value: val}); err != nil {
			// Neither memory nor disk can take it: tell the client to retry.
			s.log.Error("cannot buffer event", "err", err)
			w.Header().Set("Retry-After", "5")
			http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		s.accepted.Add(1)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) toDLQ(appID uint32, in InEvent, reason error) {
	if s.dlq == "" {
		return
	}
	payload, _ := json.Marshal(in)
	val, _ := json.Marshal(map[string]any{
		"app_id": appID, "reason": reason.Error(), "received_at": s.now().UTC().Format(time.RFC3339Nano),
		"payload": string(payload),
	})
	_ = s.sink.Enqueue(s.dlq, spool.Record{Key: fmt.Sprint(appID), Value: val})
}

var errTooLarge = errors.New("decompressed body larger than 2 MB")

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	var rd io.Reader = http.MaxBytesReader(w, r.Body, maxCompressedBody)
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(rd)
		if err != nil {
			return nil, fmt.Errorf("bad gzip: %w", err)
		}
		defer gz.Close()
		rd = gz
	}
	b, err := io.ReadAll(io.LimitReader(rd, maxDecompressedBody+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxDecompressedBody {
		return nil, errTooLarge
	}
	return b, nil
}

func allowed(list []string, origin string) bool {
	if len(list) == 0 {
		return true
	}
	for _, o := range list {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func originOrStar(r *http.Request) string {
	if o := r.Header.Get("Origin"); o != "" {
		return o
	}
	return "*"
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "collector_requests_total %d\n", s.requests.Load())
	fmt.Fprintf(w, "collector_events_accepted_total %d\n", s.accepted.Load())
	fmt.Fprintf(w, "collector_events_invalid_total %d\n", s.invalid.Load())
	fmt.Fprintf(w, "collector_requests_rate_limited_total %d\n", s.rateLimited.Load())
	fmt.Fprintf(w, "collector_requests_rejected_total %d\n", s.rejected.Load())
	if ks, ok := s.sink.(*KafkaSink); ok {
		fmt.Fprintf(w, "collector_records_produced_total %d\n", ks.Produced.Load())
		fmt.Fprintf(w, "collector_records_spooled_total %d\n", ks.Spooled.Load())
		fmt.Fprintf(w, "collector_records_failed_total %d\n", ks.Failed.Load())
		fmt.Fprintf(w, "collector_spool_bytes %d\n", ks.spool.Size())
	}
}

// UUIDv7 returns a time-ordered UUID (RFC 9562).
func UUIDv7() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(time.Now().UnixMilli())
	b[0], b[1], b[2], b[3], b[4], b[5] = byte(ms>>40), byte(ms>>32), byte(ms>>24), byte(ms>>16), byte(ms>>8), byte(ms)
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
