package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"adsb-hub/internal/event"
)

type aircraftInfo struct {
	Type         string `json:"type"`
	ICAOType     string `json:"icao_type"`
	Manufacturer string `json:"manufacturer"`
	Registration string `json:"registration"`
	Owner        string `json:"registered_owner"`
	Country      string `json:"registered_owner_country_name"`
	CountryCode  string `json:"registered_owner_country_iso_name"`
}

type aircraftCacheEntry struct {
	info  *aircraftInfo
	until time.Time
}

type aircraftDirectory struct {
	client   *http.Client
	baseURL  string
	mu       sync.Mutex
	cache    map[string]aircraftCacheEntry
	requests chan struct{}
}

func newAircraftDirectory(baseURL string) *aircraftDirectory {
	return &aircraftDirectory{
		client: &http.Client{Timeout: 4 * time.Second}, baseURL: baseURL,
		cache: make(map[string]aircraftCacheEntry), requests: make(chan struct{}, 4),
	}
}

func (d *aircraftDirectory) serve(w http.ResponseWriter, r *http.Request) {
	hex := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("hex")))
	if len(hex) != 6 || !event.Hex.MatchString(hex) {
		http.Error(w, "provide a six-digit ICAO address", http.StatusBadRequest)
		return
	}
	info, err := d.lookup(r.Context(), hex)
	if err != nil {
		http.Error(w, "aircraft directory unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, info)
}

func (d *aircraftDirectory) lookup(ctx context.Context, hex string) (*aircraftInfo, error) {
	d.mu.Lock()
	cached, exists := d.cache[hex]
	d.mu.Unlock()
	if exists && time.Now().Before(cached.until) {
		return cached.info, nil
	}
	select {
	case d.requests <- struct{}{}:
		defer func() { <-d.requests }()
	default:
		return nil, fmt.Errorf("aircraft directory at capacity")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.baseURL+strings.ToUpper(hex), nil)
	if err != nil {
		return nil, err
	}
	res, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var reply struct {
		Response struct {
			Aircraft *aircraftInfo `json:"aircraft"`
		} `json:"response"`
	}
	ttl := 6 * time.Hour
	switch res.StatusCode {
	case http.StatusOK:
		if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&reply); err != nil {
			return nil, err
		}
		if reply.Response.Aircraft == nil {
			return nil, fmt.Errorf("missing aircraft in directory response")
		}
		ttl = 24 * time.Hour
	case http.StatusNotFound:
		// Cache unlisted aircraft, but do not cache upstream errors.
	default:
		return nil, fmt.Errorf("aircraft directory returned %d", res.StatusCode)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.cache[hex]; !exists && len(d.cache) >= 4096 {
		var oldest string
		for key, entry := range d.cache {
			if oldest == "" || entry.until.Before(d.cache[oldest].until) {
				oldest = key
			}
		}
		delete(d.cache, oldest)
	}
	d.cache[hex] = aircraftCacheEntry{reply.Response.Aircraft, time.Now().Add(ttl)}
	return reply.Response.Aircraft, nil
}
