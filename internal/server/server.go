package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"adsb-hub/internal/event"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	Addr, DatabaseURL string
	Receivers         []ReceiverConfig
	LiveMaxAge        time.Duration
}

type api struct {
	db      *pgxpool.Pool
	tokens  map[string]string
	liveAge time.Duration
}

func Run(ctx context.Context, cfg Config, assets fs.FS) error {
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(startCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := initDB(startCtx, db, cfg.Receivers); err != nil {
		return fmt.Errorf("initialize PostgreSQL: %w", err)
	}
	a := api{db: db, tokens: map[string]string{}, liveAge: cfg.LiveMaxAge}
	for _, station := range cfg.Receivers {
		a.tokens[station.Token] = station.ID
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/ingest", a.ingest)
	mux.HandleFunc("GET /api/v1/live", a.live)
	mux.HandleFunc("GET /api/v1/track", a.track)
	mux.HandleFunc("GET /api/v1/trails", a.trails)
	mux.HandleFunc("GET /api/v1/aircraft", a.aircraft)
	mux.HandleFunc("GET /api/v1/receivers", a.receivers)
	mux.HandleFunc("GET /api/", http.NotFound)
	mux.Handle("GET /", http.FileServerFS(assets))

	server := &http.Server{
		Addr: cfg.Addr, Handler: mux, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second,
	}
	done := make(chan error, 1)
	go func() {
		log.Printf("server listening on %s", cfg.Addr)
		done <- server.ListenAndServe()
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
			return err
		}
		return nil
	}
}

func (a api) ingest(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	id := a.tokens[token]
	if !ok || id == "" {
		http.Error(w, "invalid station token", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			http.Error(w, "ingest batch too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "could not read batch", http.StatusBadRequest)
		return
	}
	var records []event.Event
	if err := json.Unmarshal(body, &records); err != nil || len(records) == 0 || len(records) > event.UploadBatchSize {
		http.Error(w, "invalid ingest batch", http.StatusBadRequest)
		return
	}
	for _, record := range records {
		if !validEvent(record) {
			http.Error(w, "invalid ingest event", http.StatusBadRequest)
			return
		}
	}
	if err := save(r.Context(), a.db, id, records); err != nil {
		dbError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validEvent(record event.Event) bool {
	if record.ID == "" || (record.Position == nil) == (record.Sample == nil) {
		return false
	}
	if p := record.Position; p != nil {
		return event.Hex.MatchString(p.Hex) && !p.At.IsZero() && p.Lat >= -90 && p.Lat <= 90 && p.Lon >= -180 && p.Lon <= 180
	}
	s := record.Sample
	return !s.At.IsZero() && !s.CollectedAt.IsZero() && (s.Source == "receiver" || s.Source == "stats" || s.Source == "status")
}

func (a api) live(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	args := []any{now.Add(-a.liveAge), now}
	query := `SELECT DISTINCT ON (receiver_id, hex) ` + pointColumns + ` FROM position_points
		WHERE position_at > $1 AND position_at <= $2`
	if id := r.URL.Query().Get("receiver_id"); id != "" {
		query += ` AND receiver_id = $3`
		args = append(args, id)
	}
	query += ` ORDER BY receiver_id, hex, position_at DESC, ingested_at DESC, event_id DESC`
	points, err := queryPoints(r.Context(), a.db, query, args...)
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, struct {
		Points    []Point   `json:"points"`
		ServerAt  time.Time `json:"server_time"`
		MaxAgeSec int       `json:"max_age_seconds"`
	}{points, now, int(a.liveAge / time.Second)})
}

func (a api) track(w http.ResponseWriter, r *http.Request) {
	params := r.URL.Query()
	id, hex := params.Get("receiver_id"), strings.ToLower(strings.TrimSpace(params.Get("hex")))
	from, fromErr := time.Parse(time.RFC3339, params.Get("from"))
	to, toErr := time.Parse(time.RFC3339, params.Get("to"))
	if id == "" || !event.Hex.MatchString(hex) || fromErr != nil || toErr != nil || !to.After(from) {
		http.Error(w, "provide receiver_id, hex and an increasing RFC3339 from/to range", http.StatusBadRequest)
		return
	}
	const limit = 20000
	args := []any{id, hex, from, to, limit + 1}
	filter := ` FROM position_points WHERE receiver_id = $1 AND hex = $2 AND position_at >= $3 AND position_at < $4`
	query := `SELECT ` + pointColumns + filter + ` ORDER BY position_at, event_id LIMIT $5`
	if step := params.Get("sample_seconds"); step != "" {
		seconds, err := strconv.ParseInt(step, 10, 32)
		if err != nil || seconds < 1 {
			http.Error(w, "invalid sample_seconds", http.StatusBadRequest)
			return
		}
		args = append(args, int32(seconds))
		query = `SELECT DISTINCT ON (date_bin($6::integer * interval '1 second', position_at, $3)) ` + pointColumns + filter +
			` ORDER BY date_bin($6::integer * interval '1 second', position_at, $3), position_at, event_id LIMIT $5`
	}
	points, err := queryPoints(r.Context(), a.db, query, args...)
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, struct {
		Points    []Point `json:"points"`
		Truncated bool    `json:"truncated"`
	}{points[:min(len(points), limit)], len(points) > limit})
}

func (a api) aircraft(w http.ResponseWriter, r *http.Request) {
	params := r.URL.Query()
	id, term := params.Get("receiver_id"), strings.ToLower(strings.TrimSpace(params.Get("q")))
	from, fromErr := time.Parse(time.RFC3339, params.Get("from"))
	to, toErr := time.Parse(time.RFC3339, params.Get("to"))
	if id == "" || term == "" || fromErr != nil || toErr != nil || !to.After(from) {
		http.Error(w, "provide receiver_id, q and an increasing RFC3339 from/to range", http.StatusBadRequest)
		return
	}
	matches, err := queryPoints(r.Context(), a.db, `SELECT `+pointColumns+` FROM (
		SELECT DISTINCT ON (hex) `+pointColumns+` FROM position_points
		WHERE receiver_id = $1 AND position_at >= $2 AND position_at < $3
		AND (strpos(hex, $4) > 0 OR strpos(lower(flight), $4) > 0)
		ORDER BY hex, position_at DESC, event_id DESC
	) matches ORDER BY (hex = $4 OR lower(coalesce(flight, '')) = $4) DESC, position_at DESC, hex LIMIT 20`, id, from, to, term)
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, matches)
}

func (a api) trails(w http.ResponseWriter, r *http.Request) {
	params := r.URL.Query()
	id := params.Get("receiver_id")
	from, fromErr := time.Parse(time.RFC3339, params.Get("from"))
	to, toErr := time.Parse(time.RFC3339, params.Get("to"))
	if id == "" || fromErr != nil || toErr != nil || !to.After(from) {
		http.Error(w, "provide receiver_id and an increasing RFC3339 from/to range", http.StatusBadRequest)
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT hex, lat, lon, alt_baro, on_ground,
		flight, gs, track, position_at, position_at_approximate
		FROM position_points WHERE receiver_id = $1 AND position_at >= $2 AND position_at < $3
		ORDER BY hex, position_at, event_id`, id, from, to)
	if err != nil {
		dbError(w, err)
		return
	}
	defer rows.Close()
	type routePoint struct {
		Lat           float64   `json:"lat"`
		Lon           float64   `json:"lon"`
		Alt           *int      `json:"alt_baro,omitempty"`
		OnGround      *bool     `json:"on_ground,omitempty"`
		Flight        *string   `json:"flight,omitempty"`
		GroundSpeed   *float64  `json:"gs,omitempty"`
		Track         *float64  `json:"track,omitempty"`
		At            time.Time `json:"position_at"`
		ApproximateAt bool      `json:"position_at_approximate,omitempty"`
	}
	type route struct {
		Hex      string         `json:"hex"`
		Segments [][]routePoint `json:"segments"`
	}
	routes := []route{}
	var last, firstAt, lastAt time.Time
	count := 0
	for rows.Next() {
		var hex string
		var point routePoint
		if err := rows.Scan(&hex, &point.Lat, &point.Lon, &point.Alt, &point.OnGround,
			&point.Flight, &point.GroundSpeed, &point.Track, &point.At, &point.ApproximateAt); err != nil {
			dbError(w, err)
			return
		}
		point.At = point.At.UTC()
		at := point.At
		if len(routes) == 0 || routes[len(routes)-1].Hex != hex {
			routes = append(routes, route{Hex: hex})
		}
		current := &routes[len(routes)-1]
		if len(current.Segments) == 0 || at.Sub(last) > 10*time.Minute {
			current.Segments = append(current.Segments, nil)
		}
		segment := &current.Segments[len(current.Segments)-1]
		*segment = append(*segment, point)
		last = at
		count++
		if firstAt.IsZero() || at.Before(firstAt) {
			firstAt = at.UTC()
		}
		if at.After(lastAt) {
			lastAt = at.UTC()
		}
	}
	if err := rows.Err(); err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, struct {
		Routes []route    `json:"routes"`
		Count  int        `json:"point_count"`
		First  *time.Time `json:"first_position_at,omitempty"`
		Last   *time.Time `json:"last_position_at,omitempty"`
	}{Routes: routes, Count: count, First: optionalTime(firstAt), Last: optionalTime(lastAt)})
}

func optionalTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (a api) receivers(w http.ResponseWriter, r *http.Request) {
	stations, err := queryReceivers(r.Context(), a.db, time.Now().UTC())
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, stations)
}

func dbError(w http.ResponseWriter, err error) {
	log.Printf("PostgreSQL: %v", err)
	http.Error(w, "database unavailable", http.StatusServiceUnavailable)
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}
