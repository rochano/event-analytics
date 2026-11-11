package collector

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/rochano/event-analytics/internal/spool"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Sink accepts records without blocking the HTTP handler.
type Sink interface {
	// Enqueue hands a record to the sink. It returns an error only when the
	// record could be neither buffered nor spooled to disk.
	Enqueue(topic string, rec spool.Record) error
	// Ready reports whether the collector should keep receiving traffic.
	Ready() bool
}

// KafkaSink produces to Kafka/Redpanda and falls back to the disk spool.
type KafkaSink struct {
	client       *kgo.Client
	spool        *spool.Spool
	defaultTopic string
	healthy      atomic.Bool
	log          *slog.Logger

	Produced atomic.Int64
	Spooled  atomic.Int64
	Failed   atomic.Int64
}

// KafkaConfig configures the producer.
type KafkaConfig struct {
	Brokers       []string
	Topic         string
	MaxBufferedMB int
}

// NewKafkaSink connects the producer. The broker does not have to be up:
// records spool to disk until it is.
func NewKafkaSink(cfg KafkaConfig, sp *spool.Spool, log *slog.Logger) (*KafkaSink, error) {
	maxBuf := int64(cfg.MaxBufferedMB) << 20
	if maxBuf <= 0 {
		maxBuf = 64 << 20
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.DefaultProduceTopic(cfg.Topic),
		kgo.ProducerLinger(5*time.Millisecond),
		kgo.ProducerBatchMaxBytes(1<<20),
		kgo.ProducerBatchCompression(kgo.ZstdCompression(), kgo.Lz4Compression()),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.MaxBufferedBytes(int(maxBuf)),
		// Give up on in-memory delivery quickly and move to disk instead.
		kgo.RecordDeliveryTimeout(10*time.Second),
		kgo.AllowAutoTopicCreation(),
	)
	if err != nil {
		return nil, err
	}
	s := &KafkaSink{client: cl, spool: sp, defaultTopic: cfg.Topic, log: log}
	s.healthy.Store(true)
	return s, nil
}

// Enqueue never blocks: TryProduce fails fast when the buffer is full.
func (s *KafkaSink) Enqueue(topic string, rec spool.Record) error {
	if topic == "" {
		topic = s.defaultTopic
	}
	rec.Topic = topic
	if !s.healthy.Load() {
		return s.toSpool(rec)
	}
	r := &kgo.Record{Topic: topic, Key: []byte(rec.Key), Value: rec.Value}
	s.client.TryProduce(context.Background(), r, func(_ *kgo.Record, err error) {
		if err == nil {
			s.Produced.Add(1)
			s.healthy.Store(true)
			return
		}
		if !errors.Is(err, kgo.ErrMaxBuffered) {
			s.healthy.Store(false)
		}
		if serr := s.toSpool(rec); serr != nil {
			s.Failed.Add(1)
			s.log.Error("record lost: broker and spool both failed", "err", err, "spool_err", serr)
		}
	})
	return nil
}

func (s *KafkaSink) toSpool(rec spool.Record) error {
	if err := s.spool.Append(rec); err != nil {
		return err
	}
	s.Spooled.Add(1)
	return nil
}

// Ready is false when the spool is more than 80% of its budget, so the load
// balancer moves traffic to other pods before this one runs out of disk.
func (s *KafkaSink) Ready() bool {
	return float64(s.spool.Size()) < 0.8*float64(s.spool.MaxBytes())
}

// RunReplayer moves spooled records back to the broker once it is reachable.
func (s *KafkaSink) RunReplayer(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if !s.healthy.Load() {
			pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			err := s.client.Ping(pctx)
			cancel()
			if err != nil {
				continue
			}
			s.log.Info("broker reachable again, replaying spool", "spool_bytes", s.spool.Size())
			s.healthy.Store(true)
		}
		for ctx.Err() == nil {
			ok, err := s.spool.ReplayOne(500, func(recs []spool.Record) error {
				krs := make([]*kgo.Record, len(recs))
				for i, r := range recs {
					topic := r.Topic
					if topic == "" {
						topic = s.defaultTopic
					}
					krs[i] = &kgo.Record{Topic: topic, Key: []byte(r.Key), Value: r.Value}
				}
				pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				return s.client.ProduceSync(pctx, krs...).FirstErr()
			})
			if err != nil {
				s.log.Warn("spool replay failed, will retry", "err", err)
				s.healthy.Store(false)
				break
			}
			if !ok {
				break
			}
		}
	}
}

// Close flushes buffered records and seals the spool.
func (s *KafkaSink) Close(ctx context.Context) {
	if err := s.client.Flush(ctx); err != nil {
		s.log.Warn("flush on shutdown incomplete; remaining records are spooled", "err", err)
	}
	s.client.Close()
	_ = s.spool.Close()
}
