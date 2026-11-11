// Command collector is the ingestion service.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rochano/event-analytics/internal/collector"
	"github.com/rochano/event-analytics/internal/config"
	"github.com/rochano/event-analytics/internal/spool"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	projects, err := config.ParseProjects(config.Env("PROJECTS", "1|pk_demo|rk_demo|*"))
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}
	sp, err := spool.Open(config.Env("SPOOL_DIR", "./data/spool"), int64(config.EnvInt("SPOOL_MAX_MB", 2048))<<20)
	if err != nil {
		log.Error("spool", "err", err)
		os.Exit(1)
	}
	topic := config.Env("KAFKA_TOPIC", "events.raw")
	sink, err := collector.NewKafkaSink(collector.KafkaConfig{
		Brokers:       strings.Split(config.Env("KAFKA_BROKERS", "localhost:19092"), ","),
		Topic:         topic,
		MaxBufferedMB: config.EnvInt("PRODUCER_BUFFER_MB", 64),
	}, sp, log)
	if err != nil {
		log.Error("kafka", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go sink.RunReplayer(ctx)

	srv := collector.NewServer(collector.Options{
		Projects: projects, Sink: sink, Topic: topic,
		DLQTopic: config.Env("KAFKA_DLQ_TOPIC", "events.dlq"), Log: log,
	})
	httpSrv := &http.Server{
		Addr:              config.Env("LISTEN_ADDR", ":8080"),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		log.Info("collector listening", "addr", httpSrv.Addr, "projects", len(projects))
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	sink.Close(shutdownCtx)
	log.Info("collector stopped")
}
