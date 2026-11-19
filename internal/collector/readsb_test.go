package collector

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPositionTimeAndGround(t *testing.T) {
	collected := time.Unix(1800000000, 0).UTC()
	p, err := readPosition([]byte(`{"hex":"~000001","flight":"  TEST  ","lat":0,"lon":0,"alt_baro":"ground","now":1799999990.123,"seen_pos":0.25}`), collected)
	if err != nil {
		t.Fatal(err)
	}
	if !p.At.Equal(time.Unix(1799999989, 873000000)) || p.ApproximateAt {
		t.Fatalf("unexpected position time %v, approximate=%v", p.At, p.ApproximateAt)
	}
	if p.Hex != "~000001" || p.Flight == nil || *p.Flight != "TEST" || p.AltBaro != nil || p.OnGround == nil || !*p.OnGround || p.GroundSpeed != nil {
		t.Fatalf("unexpected position: %+v", p)
	}
	p, err = readPosition([]byte(`{"hex":"000002","lat":0,"lon":0,"alt_baro":0}`), collected)
	if err != nil {
		t.Fatal(err)
	}
	if !p.ApproximateAt || !p.At.Equal(collected) || p.AltBaro == nil || *p.AltBaro != 0 || p.OnGround != nil || p.Telemetry != nil {
		t.Fatalf("unexpected fallback position: %+v", p)
	}
}

func TestReadOptionalTelemetry(t *testing.T) {
	p, err := readPosition([]byte(`{"hex":"7808a7","lat":25,"lon":110,"squawk":"0240","type":"adsb_icao","baro_rate":0,"ias":293,"rssi":-14.9,"nav_modes":["autopilot"],"t":"A321"}`), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	s := p.Telemetry
	if s == nil || s.Squawk == nil || *s.Squawk != "0240" || s.BaroRate == nil || *s.BaroRate != 0 ||
		s.IAS == nil || *s.IAS != 293 || s.RSSI == nil || *s.RSSI != -14.9 || len(s.NavModes) != 1 || s.TypeCode == nil || *s.TypeCode != "A321" || s.TAS != nil {
		t.Fatalf("unexpected telemetry: %+v", s)
	}
}

func TestStatsUseSourceTimeAndActualWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stats.json")
	if err := os.WriteFile(path, []byte(`{"now":1799999999.5,"gain_db":38.6,"last1min":{"start":1799999920,"end":1799999980,"messages_valid":0,"local":{"signal":-20}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := readSample(path, "stats")
	if err != nil {
		t.Fatal(err)
	}
	if !s.At.Equal(time.Unix(1799999999, 500000000)) || s.At.Equal(s.CollectedAt) ||
		s.MessagesPerSec == nil || *s.MessagesPerSec != 0 || s.SignalDBFS == nil || *s.SignalDBFS != -20 || s.NoiseDBFS != nil {
		t.Fatalf("unexpected stats sample: %+v", s)
	}
}
