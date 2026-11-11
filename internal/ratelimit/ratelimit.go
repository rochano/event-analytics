// Package ratelimit implements per-tenant token buckets.
//
// Each collector pod keeps its own buckets. With N pods, configure each
// tenant's rate as plan_rate / N (the design doc reconciles through Redis
// in production; a local bucket keeps the hot path free of network calls).
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
	rate   float64
	burst  float64
}

// Limiter holds one bucket per key.
type Limiter struct {
	mu      sync.Mutex
	buckets map[uint32]*bucket
	now     func() time.Time
}

// New returns an empty limiter.
func New() *Limiter {
	return &Limiter{buckets: make(map[uint32]*bucket), now: time.Now}
}

// AllowN takes n tokens from key's bucket, creating it with rate/burst if
// needed. It returns false (and takes nothing) when not enough tokens remain.
func (l *Limiter) AllowN(key uint32, n int, rate float64, burst int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(burst), last: now, rate: rate, burst: float64(burst)}
		l.buckets[key] = b
	}
	b.rate, b.burst = rate, float64(burst)
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens < float64(n) {
		return false
	}
	b.tokens -= float64(n)
	return true
}
