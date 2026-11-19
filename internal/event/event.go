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
	Hex           string     `json:"hex"`
	Flight        *string    `json:"flight"`
	Lat           float64    `json:"lat"`
	Lon           float64    `json:"lon"`
	AltBaro       *int       `json:"alt_baro"`
	OnGround      *bool      `json:"on_ground"`
	GroundSpeed   *float64   `json:"gs"`
	Track         *float64   `json:"track"`
	At            time.Time  `json:"position_at"`
	ApproximateAt bool       `json:"position_at_approximate"`
	Telemetry     *Telemetry `json:"telemetry,omitempty"`
}

// Telemetry holds optional fields from the decoder, not necessarily from the same radio frame as the position.
type Telemetry struct {
	Source       *string  `json:"type,omitempty"`
	Squawk       *string  `json:"squawk,omitempty"`
	Category     *string  `json:"category,omitempty"`
	Emergency    *string  `json:"emergency,omitempty"`
	AltGeom      *int     `json:"alt_geom,omitempty"`
	BaroRate     *int     `json:"baro_rate,omitempty"`
	GeomRate     *int     `json:"geom_rate,omitempty"`
	IAS          *float64 `json:"ias,omitempty"`
	TAS          *float64 `json:"tas,omitempty"`
	Mach         *float64 `json:"mach,omitempty"`
	MagHeading   *float64 `json:"mag_heading,omitempty"`
	TrueHeading  *float64 `json:"true_heading,omitempty"`
	Roll         *float64 `json:"roll,omitempty"`
	NavQNH       *float64 `json:"nav_qnh,omitempty"`
	NavAltMCP    *int     `json:"nav_altitude_mcp,omitempty"`
	NavAltFMS    *int     `json:"nav_altitude_fms,omitempty"`
	NavHeading   *float64 `json:"nav_heading,omitempty"`
	NavModes     []string `json:"nav_modes,omitempty"`
	RSSI         *float64 `json:"rssi,omitempty"`
	Messages     *int64   `json:"messages,omitempty"`
	NIC          *int     `json:"nic,omitempty"`
	NACP         *int     `json:"nac_p,omitempty"`
	Radius       *int     `json:"rc,omitempty"`
	Version      *int     `json:"version,omitempty"`
	WindDir      *float64 `json:"wd,omitempty"`
	WindSpeed    *float64 `json:"ws,omitempty"`
	OutsideTemp  *float64 `json:"oat,omitempty"`
	Registration *string  `json:"r,omitempty"`
	TypeCode     *string  `json:"t,omitempty"`
	Description  *string  `json:"desc,omitempty"`
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
