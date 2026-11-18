package collector

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"time"

	"adsb-hub/internal/event"
)

func unixSeconds(value float64) time.Time {
	return time.UnixMilli(int64(math.Round(value * 1000))).UTC()
}

func readPosition(line []byte, collectedAt time.Time) (*event.Position, error) {
	var wire struct {
		Hex     string          `json:"hex"`
		Flight  *string         `json:"flight"`
		Lat     *float64        `json:"lat"`
		Lon     *float64        `json:"lon"`
		AltBaro json.RawMessage `json:"alt_baro"`
		Ground  *bool           `json:"ground"`
		GS      *float64        `json:"gs"`
		Track   *float64        `json:"track"`
		Now     *float64        `json:"now"`
		SeenPos *float64        `json:"seen_pos"`
	}
	if err := json.Unmarshal(line, &wire); err != nil {
		return nil, err
	}
	if wire.Lat == nil || wire.Lon == nil {
		return nil, nil
	}
	if !event.Hex.MatchString(wire.Hex) || math.Abs(*wire.Lat) > 90 || math.Abs(*wire.Lon) > 180 {
		return nil, errors.New("invalid hex or coordinates in position")
	}
	position := &event.Position{
		Hex: wire.Hex, Lat: *wire.Lat, Lon: *wire.Lon, OnGround: wire.Ground,
		GroundSpeed: wire.GS, Track: wire.Track, At: collectedAt, ApproximateAt: true,
	}
	if wire.Flight != nil {
		if flight := strings.TrimSpace(*wire.Flight); flight != "" {
			position.Flight = &flight
		}
	}
	if string(wire.AltBaro) == `"ground"` {
		ground := true
		position.OnGround = &ground
	} else if len(wire.AltBaro) > 0 {
		if err := json.Unmarshal(wire.AltBaro, &position.AltBaro); err != nil {
			return nil, err
		}
	}
	// readsb v3.16.21 emits Unix seconds in now and position age in seconds in seen_pos.
	if wire.Now != nil && wire.SeenPos != nil && *wire.SeenPos >= 0 && *wire.Now > *wire.SeenPos {
		position.At = unixSeconds(*wire.Now - *wire.SeenPos)
		position.ApproximateAt = false
	}
	return position, nil
}

func readSample(path, source string) (*event.Sample, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	collectedAt := time.Now().UTC()
	var wire struct {
		Now             *float64 `json:"now"`
		Lat             *float64 `json:"lat"`
		Lon             *float64 `json:"lon"`
		GainDB          *float64 `json:"gain_db"`
		Uptime          *float64 `json:"uptime"`
		AircraftWithPos *int     `json:"aircraft_with_pos"`
		AircraftWithout *int     `json:"aircraft_without_pos"`
		BadTuner        *bool    `json:"bad_tuner"`
		Last1Min        struct {
			Start    float64 `json:"start"`
			End      float64 `json:"end"`
			Messages *int64  `json:"messages_valid"`
			Local    struct {
				Signal *float64 `json:"signal"`
				Noise  *float64 `json:"noise"`
			} `json:"local"`
		} `json:"last1min"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, err
	}
	sample := &event.Sample{
		Source: source, At: collectedAt, CollectedAt: collectedAt, Raw: raw,
		Lat: wire.Lat, Lon: wire.Lon, GainDB: wire.GainDB, Uptime: wire.Uptime, BadTuner: wire.BadTuner,
		AircraftWithPos: wire.AircraftWithPos, AircraftWithout: wire.AircraftWithout,
	}
	if wire.Now != nil && *wire.Now > 0 {
		sample.At = unixSeconds(*wire.Now)
	}
	if source == "stats" {
		window := wire.Last1Min
		sample.SignalDBFS, sample.NoiseDBFS = window.Local.Signal, window.Local.Noise
		if window.Messages != nil && window.Start > 0 && window.End > window.Start {
			rate := float64(*window.Messages) / (window.End - window.Start)
			sample.MessagesPerSec = &rate
		}
	}
	return sample, nil
}
