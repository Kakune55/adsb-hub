package server

import (
	"context"
	_ "embed"
	"time"

	"adsb-hub/internal/event"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

type ReceiverConfig struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

type Point struct {
	ReceiverID string `json:"receiver_id"`
	event.Position
	IngestedAt time.Time `json:"ingested_at"`
	eventID    string
}

type receiver struct {
	ID         string                  `json:"id"`
	Name       string                  `json:"name"`
	LastSample *time.Time              `json:"last_sample_at"`
	Fresh      bool                    `json:"fresh"`
	Samples    map[string]event.Sample `json:"samples"`
}

func initDB(ctx context.Context, db *pgxpool.Pool, stations []ReceiverConfig) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, schema); err != nil {
		return err
	}
	for _, station := range stations {
		if _, err := tx.Exec(ctx, `INSERT INTO receivers(id, name) VALUES ($1, $2)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, station.ID, station.Name); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func save(ctx context.Context, db *pgxpool.Pool, id string, records []event.Event) ([]Point, error) {
	batch := &pgx.Batch{}
	for _, record := range records {
		if p := record.Position; p != nil {
			batch.Queue(`INSERT INTO position_points
				(receiver_id, event_id, hex, flight, lat, lon, alt_baro, on_ground, gs, track, position_at, position_at_approximate, telemetry)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (receiver_id, event_id) DO NOTHING
				RETURNING position_at, ingested_at`,
				id, record.ID, p.Hex, p.Flight, p.Lat, p.Lon, p.AltBaro, p.OnGround, p.GroundSpeed, p.Track, p.At, p.ApproximateAt, p.Telemetry)
		} else {
			s := record.Sample
			batch.Queue(`INSERT INTO receiver_status
				(receiver_id, event_id, source, sampled_at, collected_at, lat, lon, gain_db, signal_dbfs, noise_dbfs,
				 messages_per_second, uptime_seconds, aircraft_with_pos, aircraft_without_pos, bad_tuner, raw)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (receiver_id, event_id) DO NOTHING`,
				id, record.ID, s.Source, s.At, s.CollectedAt, s.Lat, s.Lon, s.GainDB, s.SignalDBFS, s.NoiseDBFS,
				s.MessagesPerSec, s.Uptime, s.AircraftWithPos, s.AircraftWithout, s.BadTuner, s.Raw)
		}
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	results := tx.SendBatch(ctx, batch)
	defer results.Close()
	var points []Point
	for _, record := range records {
		if p := record.Position; p != nil {
			point := Point{ReceiverID: id, Position: *p, eventID: record.ID}
			if err := results.QueryRow().Scan(&point.At, &point.IngestedAt); err == pgx.ErrNoRows {
				continue // A replay did not insert another point.
			} else if err != nil {
				return nil, err
			}
			point.At, point.IngestedAt = point.At.UTC(), point.IngestedAt.UTC()
			points = append(points, point)
		} else if _, err := results.Exec(); err != nil {
			return nil, err
		}
	}
	if err := results.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return points, nil
}

const pointColumns = `receiver_id, hex, flight, lat, lon, alt_baro, on_ground, gs, track,
	position_at, position_at_approximate, ingested_at, event_id, telemetry`

func queryPoints(ctx context.Context, db *pgxpool.Pool, query string, args ...any) ([]Point, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	points := []Point{}
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.ReceiverID, &p.Hex, &p.Flight, &p.Lat, &p.Lon, &p.AltBaro, &p.OnGround,
			&p.GroundSpeed, &p.Track, &p.At, &p.ApproximateAt, &p.IngestedAt, &p.eventID, &p.Telemetry); err != nil {
			return nil, err
		}
		p.At, p.IngestedAt = p.At.UTC(), p.IngestedAt.UTC()
		points = append(points, p)
	}
	return points, rows.Err()
}

func queryReceivers(ctx context.Context, db *pgxpool.Pool, now time.Time) ([]receiver, error) {
	rows, err := db.Query(ctx, `SELECT r.id, r.name, src.source, s.sampled_at, s.collected_at, s.lat, s.lon,
		s.gain_db, s.signal_dbfs, s.noise_dbfs, s.messages_per_second, s.uptime_seconds,
		s.aircraft_with_pos, s.aircraft_without_pos, s.bad_tuner
		FROM receivers r CROSS JOIN (VALUES ('receiver'), ('stats'), ('status')) AS src(source)
		LEFT JOIN LATERAL (
			SELECT * FROM receiver_status WHERE receiver_id = r.id AND source = src.source
			ORDER BY sampled_at DESC, collected_at DESC, event_id DESC LIMIT 1
		) s ON true ORDER BY r.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stations := []receiver{}
	for rows.Next() {
		var id, name string
		var s event.Sample
		var sampledAt, collectedAt *time.Time
		if err := rows.Scan(&id, &name, &s.Source, &sampledAt, &collectedAt, &s.Lat, &s.Lon, &s.GainDB,
			&s.SignalDBFS, &s.NoiseDBFS, &s.MessagesPerSec, &s.Uptime, &s.AircraftWithPos,
			&s.AircraftWithout, &s.BadTuner); err != nil {
			return nil, err
		}
		if len(stations) == 0 || stations[len(stations)-1].ID != id {
			stations = append(stations, receiver{ID: id, Name: name, Samples: map[string]event.Sample{}})
		}
		if sampledAt != nil {
			station := &stations[len(stations)-1]
			s.At, s.CollectedAt = sampledAt.UTC(), collectedAt.UTC()
			station.Samples[s.Source] = s
			if s.Source != "receiver" && (station.LastSample == nil || s.At.After(*station.LastSample)) {
				station.LastSample = &s.At
				station.Fresh = now.Sub(s.At) <= 3*time.Minute
			}
		}
	}
	return stations, rows.Err()
}
