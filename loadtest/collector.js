// k6 load test for the collector.
//
//   docker run --rm -i --network host grafana/k6:0.55.0 run \
//     -e TARGET=http://localhost:8080 -e RPS=5000 -e DURATION=60s - < loadtest/collector.js
//
// Each request carries a batch of 1-5 events (SDK-like). After the run,
// compare k6's accepted-event count with ClickHouse:
//   SELECT count() FROM analytics.events WHERE lib = 'k6'
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const TARGET = __ENV.TARGET || "http://localhost:8080";
const KEY = __ENV.KEY || "pk_demo";
const RPS = Number(__ENV.RPS || 2000);
const DURATION = __ENV.DURATION || "30s";

export const eventsSent = new Counter("events_accepted");

export const options = {
  discardResponseBodies: true,
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: Math.round(RPS / 10),
      timeUnit: "1s",
      preAllocatedVUs: Math.min(2000, Math.max(50, Math.round(RPS / 10))),
      maxVUs: 5000,
      stages: [
        { target: RPS, duration: "10s" },  // surge
        { target: RPS, duration: DURATION }, // hold the peak
        { target: 0, duration: "5s" },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    "http_req_duration{status:204}": ["p(99)<50"],
  },
};

const events = ["$pageview", "$pageview", "$pageview", "product_viewed", "add_to_cart", "level_complete"];

export default function () {
  const n = 1 + Math.floor(Math.random() * 5);
  const batch = [];
  for (let i = 0; i < n; i++) {
    batch.push({
      event: events[Math.floor(Math.random() * events.length)],
      distinct_id: "lt_" + Math.floor(Math.random() * 200000),
      properties: { $current_url: "https://shop.example.com/p/" + Math.floor(Math.random() * 50), $lib: "k6" },
    });
  }
  const res = http.post(`${TARGET}/e`, JSON.stringify(batch), {
    headers: { "Content-Type": "text/plain", "X-Api-Key": KEY },
  });
  if (check(res, { "204": (r) => r.status === 204 })) eventsSent.add(n);
}
