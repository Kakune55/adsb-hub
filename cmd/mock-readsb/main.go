// mock-readsb provides a local JSON position stream and status files for development.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"math"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:30006", "TCP listen address")
	dir := flag.String("dir", "data/mock-readsb", "directory for receiver/stats/status JSON")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := os.MkdirAll(*dir, 0755); err != nil {
		log.Fatal(err)
	}
	writeFile(*dir, "receiver", map[string]any{"lat": 31.19, "lon": 121.56, "refresh": 1000, "readsb": true})
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	context.AfterFunc(ctx, func() { listener.Close() })
	start := time.Now()
	updateStats(*dir, start)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				updateStats(*dir, start)
			}
		}
	}()
	log.Printf("mock TCP listening on %s, files in %s", listener.Addr(), *dir)
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() == nil {
				log.Fatal(err)
			}
			return
		}
		go stream(ctx, conn, start)
	}
}

func stream(ctx context.Context, conn net.Conn, start time.Time) {
	defer conn.Close()
	encoder := json.NewEncoder(conn)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for now := range ticker.C {
		if ctx.Err() != nil {
			return
		}
		phase := now.Sub(start).Seconds() / 95
		records := []struct {
			Hex     string  `json:"hex"`
			Flight  string  `json:"flight,omitempty"`
			Lat     float64 `json:"lat"`
			Lon     float64 `json:"lon"`
			AltBaro any     `json:"alt_baro"`
			GS      float64 `json:"gs"`
			Track   float64 `json:"track"`
			Now     float64 `json:"now"`
			SeenPos float64 `json:"seen_pos"`
		}{
			{"00a7e1", "CES528", 31.55 + .29*math.Cos(phase), 121.22 + .34*math.Sin(phase), 14750, 310, heading(phase), seconds(now), .04},
			{"7815ef", "CSN352", 30.83 + .3*math.Cos(phase+1.8), 121.3 + .43*math.Sin(phase+1.8), 8650, 247, heading(phase + 1.8), seconds(now), .12},
			{"~003ab2", "", 31.1336, 121.804, "ground", 8, 160, seconds(now), 0},
		}
		conn.SetWriteDeadline(now.Add(2 * time.Second))
		for _, record := range records {
			if err := encoder.Encode(record); err != nil {
				return
			}
		}
	}
}

func heading(phase float64) float64 { return math.Mod(90+phase*180/math.Pi, 360) }
func seconds(t time.Time) float64   { return float64(t.UnixMilli()) / 1000 }

func updateStats(dir string, start time.Time) {
	now := time.Now()
	writeFile(dir, "stats", map[string]any{
		"now": seconds(now), "gain_db": 38.6, "aircraft_with_pos": 3, "aircraft_without_pos": 2,
		"last1min": map[string]any{"start": seconds(now.Add(-time.Minute)), "end": seconds(now),
			"messages_valid": 1782, "local": map[string]float64{"signal": -20.2, "noise": -36.5}},
	})
	writeFile(dir, "status", map[string]any{
		"now": seconds(now), "uptime": now.Sub(start).Seconds(), "aircraft_with_pos": 3, "aircraft_without_pos": 2,
	})
}

func writeFile(dir, name string, value any) {
	path := filepath.Join(dir, name+".json")
	data, err := json.Marshal(value)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(path+".tmp", data, 0644); err != nil {
		log.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		log.Fatal(err)
	}
}
