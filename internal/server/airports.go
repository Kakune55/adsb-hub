package server

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
)

// Public-domain OurAirports snapshot, 2026-11-19, filtered to the supported airport types.
// Source: https://github.com/davidmegginson/ourairports-data
//
//go:embed ourairports.csv.gz
var airportSnapshot []byte

type airport struct {
	ID        string  `json:"id"`
	ICAO      string  `json:"icao,omitempty"`
	IATA      string  `json:"iata,omitempty"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	Elevation *int    `json:"elevation_ft,omitempty"`
	City      string  `json:"city,omitempty"`
	Country   string  `json:"country,omitempty"`
	Scheduled bool    `json:"scheduled"`
}

func parseAirports(body io.Reader) ([]airport, error) {
	r := csv.NewReader(body)
	r.ReuseRecord = true
	header, err := r.Read()
	if err != nil {
		return nil, err
	}
	columns := make(map[string]int)
	for i, name := range header {
		columns[name] = i
	}
	for _, name := range []string{"ident", "icao_code", "iata_code", "type", "name", "latitude_deg", "longitude_deg", "elevation_ft", "municipality", "iso_country", "scheduled_service"} {
		if _, ok := columns[name]; !ok {
			return nil, fmt.Errorf("missing airport column: %s", name)
		}
	}
	var airports []airport
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		get := func(name string) string { return row[columns[name]] }
		kind, scheduled := get("type"), get("scheduled_service") == "yes"
		if kind != "large_airport" && kind != "medium_airport" && !(kind == "small_airport" && scheduled) {
			continue
		}
		lat, latErr := strconv.ParseFloat(get("latitude_deg"), 64)
		lon, lonErr := strconv.ParseFloat(get("longitude_deg"), 64)
		if latErr != nil || lonErr != nil || math.IsNaN(lat) || math.IsNaN(lon) || math.Abs(lat) > 90 || math.Abs(lon) > 180 || get("ident") == "" {
			continue
		}
		a := airport{ID: get("ident"), ICAO: get("icao_code"), IATA: get("iata_code"), Name: get("name"), Type: kind,
			Lat: lat, Lon: lon, City: get("municipality"), Country: get("iso_country"), Scheduled: scheduled}
		if elevation, err := strconv.Atoi(get("elevation_ft")); err == nil {
			a.Elevation = &elevation
		}
		airports = append(airports, a)
	}
	if len(airports) == 0 {
		return nil, fmt.Errorf("empty airport directory")
	}
	return airports, nil
}

func loadAirportSnapshot() ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(airportSnapshot))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	airports, err := parseAirports(r)
	if err != nil {
		return nil, err
	}
	return json.Marshal(airports)
}

func airportDirectory() http.HandlerFunc {
	data, err := loadAirportSnapshot()
	if err != nil {
		log.Printf("airport directory: %v", err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err != nil {
			http.Error(w, "airport directory unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(data)
	}
}
