// Time windows with a fixed timezone offset (minutes east of UTC). Times are
// epoch milliseconds; a range is half-open [from, to).
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

const iso = (ms) => new Date(ms).toISOString();

// localDay formats ms as YYYY-MM-DD in the offset's local time.
export function localDay(ms, off) {
  return iso(ms + off * 60000).slice(0, 10);
}

export function localHour(ms, off) {
  const s = iso(ms + off * 60000);
  return `${s.slice(0, 10)} ${s.slice(11, 13)}:00`;
}

// localMidnight returns the start of ms's local day.
export function localMidnight(ms, off) {
  const o = off * 60000;
  return Math.floor((ms + o) / DAY) * DAY - o;
}

// daysRange is the last n calendar days, ending now (same as the Go API).
export function daysRange(now, n, off) {
  return { from: localMidnight(now, off) - (n - 1) * DAY, to: now };
}

export function previous(r) {
  const d = r.to - r.from;
  return { from: r.from - d, to: r.from };
}

// localMonday returns the local Monday 00:00 of ms's week.
export function localMonday(ms, off) {
  const m = localMidnight(ms, off);
  const wd = new Date(m + off * 60000).getUTCDay(); // 0 = Sunday
  return m - ((wd + 6) % 7) * DAY;
}

// fillSeries returns one point per bucket, zeros included.
export function fillSeries(got, r, interval, off) {
  const out = [];
  if (interval === "hour") {
    const o = off * 60000;
    for (let t = Math.floor((r.from + o) / HOUR) * HOUR - o; t < r.to; t += HOUR) {
      const k = localHour(t, off);
      out.push({ t: k, events: got[k]?.events || 0, users: got[k]?.users || 0 });
    }
    return out;
  }
  for (let d = localMidnight(r.from, off); d < r.to; d += DAY) {
    const k = localDay(d, off);
    out.push({ t: k, events: got[k]?.events || 0, users: got[k]?.users || 0 });
  }
  return out;
}
