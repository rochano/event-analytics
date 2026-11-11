// Package spool is the collector's local disk fallback.
//
// When the broker is unreachable or the in-memory producer buffer is full,
// records are appended to segment files on local disk and replayed in order
// once the broker is healthy again. Nothing that was acknowledged with 204 is
// ever dropped for lack of a broker.
package spool

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Record is one Kafka record waiting to be produced.
type Record struct {
	Topic string          `json:"t,omitempty"`
	Key   string          `json:"k"`
	Value json.RawMessage `json:"v"`
}

// Spool writes records to rotating segment files in Dir.
type Spool struct {
	dir       string
	maxBytes  int64 // total budget; Append fails beyond it
	segBytes  int64
	segMaxAge time.Duration

	mu       sync.Mutex
	cur      *os.File
	w        *bufio.Writer
	curName  string
	curSize  int64
	curStart time.Time
	total    int64
	seq      int64
}

// Open creates the directory if needed and counts existing segments.
func Open(dir string, maxBytes int64) (*Spool, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	// Fail at startup, not during an outage, if the directory is not writable.
	probe := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return nil, fmt.Errorf("spool dir %s is not writable: %w", dir, err)
	}
	_ = os.Remove(probe)
	s := &Spool{dir: dir, maxBytes: maxBytes, segBytes: 16 << 20, segMaxAge: 2 * time.Second}
	names, err := s.segments()
	if err != nil {
		return nil, err
	}
	for _, n := range names {
		if fi, err := os.Stat(filepath.Join(dir, n)); err == nil {
			s.total += fi.Size()
		}
	}
	return s, nil
}

// ErrFull is returned when the spool has reached its disk budget.
var ErrFull = fmt.Errorf("spool full")

// Append writes records to the current segment.
func (s *Spool) Append(recs ...Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range recs {
		b, err := json.Marshal(r)
		if err != nil {
			return err
		}
		b = append(b, '\n')
		if s.total+int64(len(b)) > s.maxBytes {
			return ErrFull
		}
		if s.cur == nil || s.curSize >= s.segBytes || time.Since(s.curStart) > s.segMaxAge {
			if err := s.rotateLocked(); err != nil {
				return err
			}
		}
		n, err := s.w.Write(b)
		s.curSize += int64(n)
		s.total += int64(n)
		if err != nil {
			return err
		}
	}
	return s.w.Flush()
}

func (s *Spool) rotateLocked() error {
	if err := s.closeCurLocked(); err != nil {
		return err
	}
	s.seq++
	name := fmt.Sprintf("%020d-%06d.open", time.Now().UnixNano(), s.seq)
	f, err := os.OpenFile(filepath.Join(s.dir, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	s.cur, s.w, s.curName, s.curSize, s.curStart = f, bufio.NewWriterSize(f, 64<<10), name, 0, time.Now()
	return nil
}

// closeCurLocked seals the open segment so the replayer may pick it up.
func (s *Spool) closeCurLocked() error {
	if s.cur == nil {
		return nil
	}
	if err := s.w.Flush(); err != nil {
		return err
	}
	if err := s.cur.Sync(); err != nil {
		return err
	}
	if err := s.cur.Close(); err != nil {
		return err
	}
	old := filepath.Join(s.dir, s.curName)
	sealed := strings.TrimSuffix(old, ".open") + ".seg"
	s.cur = nil
	return os.Rename(old, sealed)
}

// Seal closes the current segment if it has data, making it replayable.
func (s *Spool) Seal() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && (s.curSize > 0 || time.Since(s.curStart) > s.segMaxAge) {
		return s.closeCurLocked()
	}
	return nil
}

// Size is the number of bytes waiting on disk.
func (s *Spool) Size() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.total
}

// MaxBytes is the disk budget.
func (s *Spool) MaxBytes() int64 { return s.maxBytes }

func (s *Spool) segments() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		// A leftover .open file from a crash is replayable too.
		if strings.HasSuffix(n, ".seg") || strings.HasSuffix(n, ".open") {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, nil
}

// ReplayOne sends the oldest sealed segment to fn in batches and deletes it
// when every batch succeeded. It returns false when nothing was replayed.
func (s *Spool) ReplayOne(batch int, fn func([]Record) error) (bool, error) {
	if err := s.Seal(); err != nil {
		return false, err
	}
	s.mu.Lock()
	names, err := s.segments()
	cur := s.curName
	open := s.cur != nil
	s.mu.Unlock()
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if open && n == cur {
			continue
		}
		path := filepath.Join(s.dir, n)
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		if err := replayFile(path, batch, fn); err != nil {
			return false, err
		}
		if err := os.Remove(path); err != nil {
			return false, err
		}
		s.mu.Lock()
		s.total -= fi.Size()
		if s.total < 0 {
			s.total = 0
		}
		s.mu.Unlock()
		return true, nil
	}
	return false, nil
}

func replayFile(path string, batch int, fn func([]Record) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	buf := make([]Record, 0, batch)
	for sc.Scan() {
		var r Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue // torn last line after a crash
		}
		buf = append(buf, r)
		if len(buf) == batch {
			if err := fn(buf); err != nil {
				return err
			}
			buf = buf[:0]
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if len(buf) > 0 {
		return fn(buf)
	}
	return nil
}

// Close seals the open segment.
func (s *Spool) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeCurLocked()
}
