// Command seed fills a fresh install with realistic demo data.
//
// It writes straight to the events topic (bypassing the collector's 7-day
// age limit) so dashboards show weeks of history right away:
//
//	go run ./cmd/seed -brokers localhost:19092 -days 60 -users 4000
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"time"

	"github.com/rochano/event-analytics/internal/collector"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	brokers := flag.String("brokers", "localhost:19092", "Kafka/Redpanda brokers")
	topic := flag.String("topic", "events.raw", "topic")
	appID := flag.Uint("app", 1, "app_id")
	days := flag.Int("days", 60, "days of history")
	users := flag.Int("users", 4000, "new users over the period")
	seed := flag.Int64("seed", 42, "random seed")
	flag.Parse()

	cl, err := kgo.NewClient(kgo.SeedBrokers(*brokers), kgo.DefaultProduceTopic(*topic),
		kgo.ProducerBatchCompression(kgo.ZstdCompression()), kgo.ProducerLinger(20*time.Millisecond))
	if err != nil {
		log.Fatal(err)
	}
	defer cl.Close()

	rng := rand.New(rand.NewSource(*seed))
	now := time.Now().UTC()
	start := now.AddDate(0, 0, -*days)

	pages := []string{"/", "/", "/", "/products/sneaker-x", "/products/runner-2", "/sale/11-11", "/blog/size-guide", "/about"}
	refs := []string{"", "", "https://www.google.com/", "https://www.google.com/", "https://www.facebook.com/", "https://line.me/", "https://www.tiktok.com/"}
	uas := []string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
		"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36 Line/14.6.0",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
	}
	countries := []string{"TH", "TH", "TH", "TH", "TH", "TH", "SG", "MY", "JP", "US"}

	var sent int
	produce := func(in collector.InEvent, ts time.Time, ua, country string) {
		out, err := collector.Normalize(in, uint32(*appID), 395,
			collector.RequestMeta{ReceivedAt: ts, UserAgent: ua, Country: country}, collector.UUIDv7)
		if err != nil {
			log.Fatalf("normalize: %v", err)
		}
		b, _ := json.Marshal(out)
		cl.Produce(context.Background(), &kgo.Record{Key: []byte(fmt.Sprintf("%d:%s", *appID, in.DistinctID)), Value: b}, nil)
		sent++
	}
	raw := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

	for u := 0; u < *users; u++ {
		// More signups recently, plus a spike on the most recent 11.11 sale.
		f := math.Sqrt(rng.Float64())
		first := start.Add(time.Duration(f * float64(now.Sub(start))))
		id := fmt.Sprintf("u_%06d", u)
		ua := uas[rng.Intn(len(uas))]
		country := countries[rng.Intn(len(countries))]
		ref := refs[rng.Intn(len(refs))]
		loyal := rng.Float64() < 0.25

		visit := first
		for v := 0; visit.Before(now); v++ {
			sess := fmt.Sprintf("s_%s_%d", id, v)
			t := visit
			n := 1 + rng.Intn(6)
			for i := 0; i < n && t.Before(now); i++ {
				page := pages[rng.Intn(len(pages))]
				props := map[string]json.RawMessage{
					"$current_url": raw("https://shop.example.com" + page),
					"$lib":         raw("web"),
				}
				if i == 0 && v == 0 {
					props["$referrer"] = raw(ref)
				}
				produce(collector.InEvent{Event: "$pageview", DistinctID: id, SessionID: sess, Properties: props}, t, ua, country)
				t = t.Add(time.Duration(10+rng.Intn(120)) * time.Second)
			}
			// Purchase funnel.
			if rng.Float64() < 0.35 && t.Before(now) {
				produce(collector.InEvent{Event: "product_viewed", DistinctID: id, SessionID: sess,
					Properties: map[string]json.RawMessage{"sku": raw("SNK-X"), "price": raw(2490)}}, t, ua, country)
				if rng.Float64() < 0.32 {
					t = t.Add(40 * time.Second)
					produce(collector.InEvent{Event: "add_to_cart", DistinctID: id, SessionID: sess,
						Properties: map[string]json.RawMessage{"sku": raw("SNK-X")}}, t, ua, country)
					if rng.Float64() < 0.55 {
						t = t.Add(90 * time.Second)
						produce(collector.InEvent{Event: "checkout_started", DistinctID: id, SessionID: sess}, t, ua, country)
						if rng.Float64() < 0.65 {
							t = t.Add(60 * time.Second)
							produce(collector.InEvent{Event: "purchase", DistinctID: id, SessionID: sess,
								Properties: map[string]json.RawMessage{"revenue": raw(2490), "currency": raw("THB")}}, t, ua, country)
						}
					}
				}
			}
			// Return visits: loyal users come back often.
			gap := 2 + rng.ExpFloat64()*6
			if loyal {
				gap = 0.5 + rng.ExpFloat64()*2
			}
			if !loyal && rng.Float64() < 0.45 {
				break
			}
			visit = visit.Add(time.Duration(gap*24) * time.Hour)
		}
	}
	if err := cl.Flush(context.Background()); err != nil {
		log.Fatal(err)
	}
	log.Printf("sent %d events for %d users over %d days", sent, *users, *days)
}
