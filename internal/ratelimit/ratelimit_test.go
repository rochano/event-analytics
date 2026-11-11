package ratelimit

import (
	"testing"
	"time"
)

func TestAllowNRefills(t *testing.T) {
	l := New()
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }

	if !l.AllowN(1, 10, 5, 10) {
		t.Fatal("first 10 tokens should be allowed (full bucket)")
	}
	if l.AllowN(1, 1, 5, 10) {
		t.Fatal("bucket should be empty")
	}
	now = now.Add(time.Second) // +5 tokens
	if !l.AllowN(1, 5, 5, 10) {
		t.Fatal("5 tokens should have refilled")
	}
	if l.AllowN(1, 1, 5, 10) {
		t.Fatal("bucket should be empty again")
	}
	if !l.AllowN(2, 10, 5, 10) {
		t.Fatal("other tenants have their own bucket")
	}
}
