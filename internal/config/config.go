// Package config loads service settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Project is one tenant (app) that may send or read events.
type Project struct {
	AppID          uint32
	WriteKey       string   // public key embedded in SDKs (write-only)
	ReadKey        string   // secret key for the query API
	AllowedOrigins []string // empty = any origin
	RatePerSec     float64  // sustained events/second
	Burst          int      // bucket size
	RetentionDays  uint16
	Name           string // shown in the dashboard header; optional
}

// ParseProjects parses PROJECTS, a semicolon-separated list of
// app_id|write_key|read_key|origins(comma)|rate|burst|retention_days|name.
// Only app_id and write_key are required.
//
//	PROJECTS="1|pk_demo|rk_demo|http://localhost:8080|2000|6000|395|Demo shop"
func ParseProjects(s string) ([]Project, error) {
	var out []Project
	for _, raw := range strings.Split(s, ";") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		f := strings.Split(raw, "|")
		if len(f) < 2 {
			return nil, fmt.Errorf("project %q: need at least app_id|write_key", raw)
		}
		id, err := strconv.ParseUint(f[0], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("project %q: bad app_id: %w", raw, err)
		}
		p := Project{AppID: uint32(id), WriteKey: f[1], RatePerSec: 1000, Burst: 3000, RetentionDays: 395}
		if len(f) > 2 {
			p.ReadKey = f[2]
		}
		if len(f) > 3 && f[3] != "" && f[3] != "*" {
			for _, o := range strings.Split(f[3], ",") {
				if o = strings.TrimSpace(o); o != "" {
					p.AllowedOrigins = append(p.AllowedOrigins, o)
				}
			}
		}
		if len(f) > 4 && f[4] != "" {
			if p.RatePerSec, err = strconv.ParseFloat(f[4], 64); err != nil {
				return nil, fmt.Errorf("project %q: bad rate: %w", raw, err)
			}
		}
		if len(f) > 5 && f[5] != "" {
			if p.Burst, err = strconv.Atoi(f[5]); err != nil {
				return nil, fmt.Errorf("project %q: bad burst: %w", raw, err)
			}
		}
		if len(f) > 6 && f[6] != "" {
			d, err := strconv.ParseUint(f[6], 10, 16)
			if err != nil {
				return nil, fmt.Errorf("project %q: bad retention: %w", raw, err)
			}
			p.RetentionDays = uint16(d)
		}
		if len(f) > 7 {
			p.Name = strings.TrimSpace(f[7])
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no projects configured")
	}
	return out, nil
}

// Env returns the variable or a default.
func Env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// EnvInt returns an int variable or a default.
func EnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// EnvDuration returns a duration variable or a default.
func EnvDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
