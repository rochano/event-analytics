package collector

import (
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Limits from the integration contract (INTEGRATION.md).
const (
	MaxEventsPerBatch = 100
	MaxEventBytes     = 32 << 10
	MaxProperties     = 200
	MaxEventName      = 255
	MaxPastAge        = 7 * 24 * time.Hour
	MaxFutureSkew     = time.Hour
)

var propKeyRe = regexp.MustCompile(`^[$a-zA-Z0-9_.\-]{1,128}$`)

// InEvent is one event as an SDK sends it.
type InEvent struct {
	Event      string                     `json:"event"`
	DistinctID string                     `json:"distinct_id"`
	Timestamp  string                     `json:"timestamp,omitempty"`
	UUID       string                     `json:"event_uuid,omitempty"`
	SessionID  string                     `json:"session_id,omitempty"`
	Properties map[string]json.RawMessage `json:"properties,omitempty"`
}

// envelope is the object form of a batch: {"api_key","sent_at","batch":[...]}.
type envelope struct {
	APIKey string    `json:"api_key"`
	SentAt string    `json:"sent_at"`
	Batch  []InEvent `json:"batch"`
}

// ParseBatch accepts a JSON array of events, a single event object, or an
// envelope object. It returns the events, the api key from the body (if any)
// and the batch sent_at (if any).
func ParseBatch(body []byte) ([]InEvent, string, string, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, "", "", errors.New("empty body")
	}
	if trimmed[0] == '[' {
		var evs []InEvent
		if err := json.Unmarshal(body, &evs); err != nil {
			return nil, "", "", fmt.Errorf("bad json: %w", err)
		}
		return evs, "", "", nil
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, "", "", fmt.Errorf("bad json: %w", err)
	}
	if env.Batch != nil {
		return env.Batch, env.APIKey, env.SentAt, nil
	}
	var ev InEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, "", "", fmt.Errorf("bad json: %w", err)
	}
	return []InEvent{ev}, env.APIKey, env.SentAt, nil
}

// OutEvent is the row written to Kafka and read by ClickHouse (JSONEachRow).
// Field names match the events_queue table in clickhouse/schema.sql.
type OutEvent struct {
	AppID          uint32 `json:"app_id"`
	Timestamp      string `json:"timestamp"`
	Event          string `json:"event"`
	EventUUID      string `json:"event_uuid"`
	DistinctID     string `json:"distinct_id"`
	PersonID       string `json:"person_id"`
	SessionID      string `json:"session_id"`
	URL            string `json:"url"`
	Pathname       string `json:"pathname"`
	ReferrerDomain string `json:"referrer_domain"`
	UTMSource      string `json:"utm_source"`
	UTMMedium      string `json:"utm_medium"`
	UTMCampaign    string `json:"utm_campaign"`
	CountryCode    string `json:"country_code"`
	Region         string `json:"region"`
	City           string `json:"city"`
	DeviceType     string `json:"device_type"`
	OS             string `json:"os"`
	Browser        string `json:"browser"`
	AppVersion     string `json:"app_version"`
	Lib            string `json:"lib"`
	Properties     string `json:"properties"` // JSON object as a string
	RetentionDays  uint16 `json:"retention_days"`
	ReceivedAt     string `json:"received_at"`
}

// RequestMeta is what the HTTP layer knows about the request.
type RequestMeta struct {
	ReceivedAt time.Time
	SentAt     time.Time // zero if unknown
	UserAgent  string
	Country    string // from a trusted edge header such as CF-IPCountry
	Region     string
	City       string
}

const chTime = "2006-01-02 15:04:05.000"

// Normalize validates an event and turns it into an OutEvent.
// newUUID is used when the client did not send event_uuid.
func Normalize(in InEvent, appID uint32, retention uint16, meta RequestMeta, newUUID func() string) (OutEvent, error) {
	if in.Event == "" || len(in.Event) > MaxEventName {
		return OutEvent{}, errors.New("event name missing or longer than 255")
	}
	if in.DistinctID == "" || len(in.DistinctID) > 200 {
		return OutEvent{}, errors.New("distinct_id missing or longer than 200")
	}
	if len(in.Properties) > MaxProperties {
		return OutEvent{}, fmt.Errorf("more than %d properties", MaxProperties)
	}
	for k := range in.Properties {
		if !propKeyRe.MatchString(k) {
			return OutEvent{}, fmt.Errorf("invalid property key %q", k)
		}
	}

	ts := meta.ReceivedAt
	if in.Timestamp != "" {
		t, err := time.Parse(time.RFC3339Nano, in.Timestamp)
		if err != nil {
			return OutEvent{}, fmt.Errorf("bad timestamp: %w", err)
		}
		// Correct device clock skew using the batch's sent_at.
		if !meta.SentAt.IsZero() {
			t = t.Add(meta.ReceivedAt.Sub(meta.SentAt))
		}
		ts = t
	}
	if meta.ReceivedAt.Sub(ts) > MaxPastAge {
		return OutEvent{}, errors.New("timestamp older than 7 days")
	}
	if ts.Sub(meta.ReceivedAt) > MaxFutureSkew {
		return OutEvent{}, errors.New("timestamp more than 1 hour in the future")
	}

	props := in.Properties
	if props == nil {
		props = map[string]json.RawMessage{}
	}
	propsJSON, err := json.Marshal(props)
	if err != nil {
		return OutEvent{}, err
	}
	if len(propsJSON) > MaxEventBytes {
		return OutEvent{}, errors.New("event larger than 32 KB")
	}

	id := in.UUID
	if !validUUID(id) {
		id = newUUID()
	}

	out := OutEvent{
		AppID:         appID,
		Timestamp:     ts.UTC().Format(chTime),
		Event:         in.Event,
		EventUUID:     id,
		DistinctID:    in.DistinctID,
		PersonID:      PersonID(appID, in.DistinctID),
		SessionID:     in.SessionID,
		Properties:    string(propsJSON),
		RetentionDays: retention,
		ReceivedAt:    meta.ReceivedAt.UTC().Format(chTime),
		CountryCode:   strings.ToUpper(meta.Country),
		Region:        meta.Region,
		City:          meta.City,
	}
	if len(out.CountryCode) != 2 {
		out.CountryCode = ""
	}

	str := func(k string) string {
		raw, ok := props[k]
		if !ok {
			return ""
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return s
	}

	if u := str("$current_url"); u != "" {
		out.URL = u
		if pu, err := url.Parse(u); err == nil {
			out.Pathname = pu.Path
			q := pu.Query()
			out.UTMSource, out.UTMMedium, out.UTMCampaign = q.Get("utm_source"), q.Get("utm_medium"), q.Get("utm_campaign")
		}
	}
	if p := str("$pathname"); p != "" {
		out.Pathname = p
	}
	if out.UTMSource == "" {
		out.UTMSource = str("utm_source")
	}
	out.ReferrerDomain = referrerDomain(str("$referrer"), out.URL)

	ua := str("$user_agent")
	if ua == "" {
		ua = meta.UserAgent
	}
	out.DeviceType, out.OS, out.Browser = ParseUA(ua)
	if v := str("$device_type"); v != "" {
		out.DeviceType = v
	}
	if v := str("$os"); v != "" {
		out.OS = v
	}
	out.AppVersion = firstNonEmpty(str("$app_version"), str("app_version"))
	out.Lib = str("$lib")
	return out, nil
}

// PersonID derives a stable UUID for (app, distinct_id). The MVP has no
// identity merging; $identify-based merging belongs in the enricher (see docs).
func PersonID(appID uint32, distinctID string) string {
	h := sha1.Sum([]byte(fmt.Sprintf("%d:%s", appID, distinctID)))
	h[6] = (h[6] & 0x0f) | 0x50 // version 5
	h[8] = (h[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

func referrerDomain(ref, current string) string {
	if ref == "" {
		return "$direct"
	}
	ru, err := url.Parse(ref)
	if err != nil || ru.Host == "" {
		return "$direct"
	}
	host := strings.TrimPrefix(strings.ToLower(ru.Hostname()), "www.")
	if cu, err := url.Parse(current); err == nil && strings.TrimPrefix(strings.ToLower(cu.Hostname()), "www.") == host {
		return "$direct" // internal navigation
	}
	return host
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validUUID(s string) bool { return uuidRe.MatchString(s) }

// ParseUA is a deliberately small user-agent classifier. Swap for a full
// parser (e.g. uap-go) in the enricher when more detail is needed.
func ParseUA(ua string) (device, os, browser string) {
	l := strings.ToLower(ua)
	if l == "" {
		return "", "", ""
	}
	switch {
	case strings.Contains(l, "ipad") || strings.Contains(l, "tablet"):
		device = "Tablet"
	case strings.Contains(l, "mobi") || strings.Contains(l, "iphone") || strings.Contains(l, "android"):
		device = "Mobile"
	case strings.Contains(l, "bot") || strings.Contains(l, "spider") || strings.Contains(l, "crawl"):
		device = "Bot"
	case strings.Contains(l, "mozilla"):
		device = "Desktop"
	default:
		device = "Other" // game engines, servers, curl
	}
	switch {
	case strings.Contains(l, "iphone") || strings.Contains(l, "ipad") || strings.Contains(l, "ios"):
		os = "iOS"
	case strings.Contains(l, "android"):
		os = "Android"
	case strings.Contains(l, "windows"):
		os = "Windows"
	case strings.Contains(l, "mac os") || strings.Contains(l, "macintosh"):
		os = "macOS"
	case strings.Contains(l, "linux"):
		os = "Linux"
	}
	switch {
	case strings.Contains(l, "edg/"):
		browser = "Edge"
	case strings.Contains(l, "line/"):
		browser = "LINE"
	case strings.Contains(l, "fban") || strings.Contains(l, "fbav"):
		browser = "Facebook"
	case strings.Contains(l, "samsungbrowser"):
		browser = "Samsung Internet"
	case strings.Contains(l, "chrome/") || strings.Contains(l, "crios"):
		browser = "Chrome"
	case strings.Contains(l, "firefox/") || strings.Contains(l, "fxios"):
		browser = "Firefox"
	case strings.Contains(l, "safari/"):
		browser = "Safari"
	case strings.Contains(l, "unity") || strings.Contains(l, "unreal") || strings.Contains(l, "godot"):
		browser = "Game engine"
	}
	return device, os, browser
}
