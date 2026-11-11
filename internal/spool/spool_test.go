package spool

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestAppendReplayInOrder(t *testing.T) {
	s, err := Open(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		if err := s.Append(Record{Key: fmt.Sprint(i), Value: json.RawMessage(fmt.Sprintf(`{"n":%d}`, i))}); err != nil {
			t.Fatal(err)
		}
	}
	if s.Size() == 0 {
		t.Fatal("size should be > 0")
	}

	var got []string
	failOnce := true
	send := func(rs []Record) error {
		if failOnce {
			failOnce = false
			return errors.New("broker down")
		}
		for _, r := range rs {
			got = append(got, r.Key)
		}
		return nil
	}
	if _, err := s.ReplayOne(10, send); err == nil {
		t.Fatal("expected error from first replay")
	}
	ok, err := s.ReplayOne(10, send)
	if err != nil || !ok {
		t.Fatalf("replay: ok=%v err=%v", ok, err)
	}
	if len(got) != 25 || got[0] != "0" || got[24] != "24" {
		t.Fatalf("replayed out of order or incomplete: %v", got)
	}
	if s.Size() != 0 {
		t.Fatalf("size after replay = %d", s.Size())
	}
	if ok, _ := s.ReplayOne(10, send); ok {
		t.Fatal("nothing left to replay")
	}
}

func TestBudget(t *testing.T) {
	s, err := Open(t.TempDir(), 64)
	if err != nil {
		t.Fatal(err)
	}
	big := json.RawMessage(`{"x":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)
	if err := s.Append(Record{Key: "k", Value: big}); !errors.Is(err, ErrFull) {
		t.Fatalf("want ErrFull, got %v", err)
	}
}

func TestReopenCountsLeftovers(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 1<<20)
	_ = s.Append(Record{Key: "a", Value: json.RawMessage(`1`)})
	_ = s.Close()
	s2, err := Open(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Size() == 0 {
		t.Fatal("reopened spool should see leftover segment")
	}
	n := 0
	if ok, err := s2.ReplayOne(100, func(rs []Record) error { n += len(rs); return nil }); !ok || err != nil || n != 1 {
		t.Fatalf("ok=%v err=%v n=%d", ok, err, n)
	}
}
