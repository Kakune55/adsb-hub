package server

import (
	"testing"

	"adsb-hub/internal/event"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestTelemetryJSONB(t *testing.T) {
	codec := pgtype.NewMap()
	squawk := "0240"
	for _, input := range []*event.Telemetry{nil, {Squawk: &squawk}} {
		data, err := codec.Encode(pgtype.JSONBOID, pgtype.TextFormatCode, input, nil)
		if err != nil {
			t.Fatal(err)
		}
		var point Point
		if err := codec.Scan(pgtype.JSONBOID, pgtype.TextFormatCode, data, &point.Telemetry); err != nil {
			t.Fatal(err)
		}
		if input == nil && point.Telemetry != nil || input != nil && (point.Telemetry == nil || point.Telemetry.Squawk == nil || *point.Telemetry.Squawk != squawk) {
			t.Fatalf("unexpected database round trip: %+v", point.Telemetry)
		}
	}
}
