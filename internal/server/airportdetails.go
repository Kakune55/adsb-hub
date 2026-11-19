package server

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// OurAirports public-domain runway and frequency data, 2026-11-19.
//
//go:embed airport-details.json.gz
var airportDetailsSnapshot []byte

func airportDetails() http.HandlerFunc {
	var rows map[string]json.RawMessage
	r, err := gzip.NewReader(bytes.NewReader(airportDetailsSnapshot))
	if err == nil {
		err = json.NewDecoder(r).Decode(&rows)
		_ = r.Close()
	}
	if err != nil {
		log.Printf("airport details: %v", err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err != nil {
			http.Error(w, "airport details unavailable", http.StatusServiceUnavailable)
			return
		}
		data := rows[r.URL.Query().Get("id")]
		if data == nil {
			data = json.RawMessage(`{"runways":[],"frequencies":[]}`)
		}
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(data)
	}
}

var weatherICAO = regexp.MustCompile(`^[A-Z]{4}$`)

func airportWeather(baseURL string) http.HandlerFunc {
	client := &http.Client{Timeout: 6 * time.Second}
	slots := make(chan struct{}, 8)
	return func(w http.ResponseWriter, r *http.Request) {
		kind := r.URL.Query().Get("kind")
		icao := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("icao")))
		if (kind != "metar" && kind != "taf") || !weatherICAO.MatchString(icao) {
			http.Error(w, "invalid weather request", http.StatusBadRequest)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			http.Error(w, "weather temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, baseURL+kind+"?ids="+icao+"&format=json", nil)
		if err != nil {
			http.Error(w, "weather unavailable", http.StatusBadGateway)
			return
		}
		res, err := client.Do(req)
		if err != nil {
			http.Error(w, "weather unavailable", http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		var reports []map[string]json.RawMessage
		if res.StatusCode != http.StatusNoContent && (res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 128<<10)).Decode(&reports) != nil) {
			http.Error(w, "weather unavailable", http.StatusBadGateway)
			return
		}
		var latest map[string]json.RawMessage
		for _, report := range reports {
			var station string
			if json.Unmarshal(report["icaoId"], &station) != nil || station != icao {
				continue
			}
			latest = make(map[string]json.RawMessage)
			for _, key := range []string{"reportTime", "issueTime", "validTimeFrom", "validTimeTo", "rawOb", "rawTAF", "temp", "dewp", "wdir", "wspd", "wgst", "visib", "altim", "fltCat"} {
				if value := report[key]; len(value) != 0 {
					latest[key] = value
				}
			}
			break
		}
		w.Header().Set("Cache-Control", "public, max-age=240")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(latest)
	}
}
