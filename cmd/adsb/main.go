package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"adsb-hub/frontend"
	"adsb-hub/internal/collector"
	"adsb-hub/internal/server"
)

func main() {
	if len(os.Args) != 2 || (os.Args[1] != "collector" && os.Args[1] != "server") {
		fmt.Fprintln(os.Stderr, "Usage: adsb {server|collector} (see README.md for environment variables)")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	run := runServer
	if os.Args[1] == "collector" {
		run = runCollector
	}
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func runCollector(ctx context.Context) error {
	limit, err := positiveInt("ADSB_QUEUE_LIMIT", "100000")
	if err != nil {
		return err
	}
	cfg := collector.Config{
		TCPAddr: env("ADSB_READSB_ADDR", "127.0.0.1:30006"), ReadsbDir: env("ADSB_READSB_DIR", "/run/readsb"),
		QueuePath: env("ADSB_QUEUE_PATH", "data/queue.sqlite"), QueueLimit: limit,
		IngestURL: os.Getenv("ADSB_INGEST_URL"), Token: os.Getenv("ADSB_TOKEN"),
	}
	u, err := url.Parse(cfg.IngestURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || cfg.Token == "" {
		return errors.New("set ADSB_INGEST_URL to the full HTTP(S) ingest endpoint and ADSB_TOKEN to the station token")
	}
	lat, lon := os.Getenv("ADSB_LAT"), os.Getenv("ADSB_LON")
	if lat != "" || lon != "" {
		latitude, latErr := strconv.ParseFloat(lat, 64)
		longitude, lonErr := strconv.ParseFloat(lon, 64)
		if latErr != nil || lonErr != nil || !(math.Abs(latitude) <= 90 && math.Abs(longitude) <= 180) {
			return errors.New("set both ADSB_LAT and ADSB_LON in decimal degrees, within ±90 and ±180")
		}
		cfg.Lat, cfg.Lon = &latitude, &longitude
	}
	return collector.Run(ctx, cfg)
}

func runServer(ctx context.Context) error {
	cfg := server.Config{Addr: env("ADSB_LISTEN", "127.0.0.1:8080"), DatabaseURL: os.Getenv("DATABASE_URL")}
	cfg.WebUser = os.Getenv("ADSB_WEB_USER")
	cfg.WebPassword = os.Getenv("ADSB_WEB_PASSWORD")
	cfg.WebTrustedProxies = os.Getenv("ADSB_WEB_TRUSTED_PROXIES")
	if cfg.DatabaseURL == "" {
		return errors.New("set DATABASE_URL to the PostgreSQL connection URL")
	}
	if err := json.Unmarshal([]byte(os.Getenv("ADSB_RECEIVERS")), &cfg.Receivers); err != nil || len(cfg.Receivers) == 0 {
		return errors.New("set ADSB_RECEIVERS to a JSON array of {id, name, token} station objects")
	}
	ids, tokens := map[string]bool{}, map[string]bool{}
	for _, station := range cfg.Receivers {
		if strings.TrimSpace(station.ID) == "" || strings.TrimSpace(station.Name) == "" || station.Token == "" ||
			strings.ContainsAny(station.Token, " \t\r\n") || ids[station.ID] || tokens[station.Token] {
			return errors.New("each station needs a name and a unique, nonempty id and bearer token")
		}
		ids[station.ID], tokens[station.Token] = true, true
	}
	seconds, err := positiveInt("ADSB_LIVE_MAX_AGE_SECONDS", "60")
	if err != nil {
		return err
	}
	cfg.LiveMaxAge = time.Duration(seconds) * time.Second
	assets, err := fs.Sub(frontend.FS, "dist")
	if err != nil {
		return err
	}
	return server.Run(ctx, cfg, assets)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func positiveInt(key, fallback string) (int, error) {
	value, err := strconv.Atoi(env(key, fallback))
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}
