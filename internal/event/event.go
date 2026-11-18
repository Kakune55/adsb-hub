package event

import (
	"encoding/json"
	"regexp"
	"time"
)

const UploadBatchSize = 128

var Hex = regexp.MustCompile(`^~?[0-9a-f]{6}$`)

type Event struct {
	ID       string    `json:"event_id"`
	Position *Position `json:"position,omitempty"`
	Sample   *Sample   `json:"sample,omitempty"`
}

type Position struct {
	Hex           string    `json:"hex"`
	Flight        *string   `json:"flight"`
	Lat           float64   `json:"lat"`
	Lon           float64   `json:"lon"`
	AltBaro       *int      `json:"alt_baro"`
	OnGround      *bool     `json:"on_ground"`
	GroundSpeed   *float64  `json:"gs"`
	Track         *float64  `json:"track"`
	At            time.Time `json:"position_at"`
	ApproximateAt bool      `json:"position_at_approximate"`
}

type Sample struct {
	Source          string          `json:"source"`
	At              time.Time       `json:"sampled_at"`
	CollectedAt     time.Time       `json:"collected_at"`
	Lat             *float64        `json:"lat"`
	Lon             *float64        `json:"lon"`
	GainDB          *float64        `json:"gain_db"`
	SignalDBFS      *float64        `json:"signal_dbfs"`
	NoiseDBFS       *float64        `json:"noise_dbfs"`
	MessagesPerSec  *float64        `json:"messages_per_second"`
	Uptime          *float64        `json:"uptime_seconds"`
	AircraftWithPos *int            `json:"aircraft_with_pos"`
	AircraftWithout *int            `json:"aircraft_without_pos"`
	BadTuner        *bool           `json:"bad_tuner"`
	Raw             json.RawMessage `json:"raw,omitempty"`
}
