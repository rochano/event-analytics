// Command queryapi serves the dashboard and its JSON API.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rochano/event-analytics/internal/config"
	"github.com/rochano/event-analytics/internal/query"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	projects, err := config.ParseProjects(config.Env("PROJECTS", "1|pk_demo|rk_demo|*"))
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}
	tz := config.Env("TIMEZONE", "Asia/Bangkok")
	store, err := query.Open(
		config.Env("CLICKHOUSE_ADDR", "localhost:9000"),
		config.Env("CLICKHOUSE_USER", "query_api"),
		config.Env("CLICKHOUSE_PASSWORD", "query_api_dev_password"),
		tz,
	)
	if err != nil {
		log.Error("clickhouse", "err", err)
		os.Exit(1)
	}
	api := query.NewAPI(store, projects, tz, config.Env("COLLECTOR_PUBLIC_URL", "http://localhost:8080"), log)

	mux := http.NewServeMux()
	mux.Handle("/sdk/", http.StripPrefix("/sdk/", http.FileServer(http.Dir(config.Env("SDK_DIR", "./sdk/js")))))
	mux.Handle("/", api.Handler(config.Env("WEB_DIR", "./web")))

	srv := &http.Server{
		Addr:              config.Env("LISTEN_ADDR", ":8081"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Info("query api listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
}
