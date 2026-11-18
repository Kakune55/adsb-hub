package collector

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"

	"adsb-hub/internal/event"
	_ "modernc.org/sqlite"
)

func openQueue(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode = WAL;
		PRAGMA synchronous = FULL;
		CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func enqueue(ctx context.Context, db *sql.DB, batch []event.Event, limit int) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM queue`).Scan(&count); err != nil {
		return 0, err
	}
	added := min(len(batch), max(0, limit-count))
	for _, record := range batch[:added] {
		payload, err := json.Marshal(record)
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO queue(payload) VALUES (?)`, string(payload)); err != nil {
			return 0, err
		}
	}
	return added, tx.Commit()
}

func oldest(ctx context.Context, db *sql.DB) ([]json.RawMessage, int64, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, payload FROM queue ORDER BY id LIMIT ?`, event.UploadBatchSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var batch []json.RawMessage
	var lastID int64
	for rows.Next() {
		var payload string
		if err := rows.Scan(&lastID, &payload); err != nil {
			return nil, 0, err
		}
		batch = append(batch, json.RawMessage(payload))
	}
	return batch, lastID, rows.Err()
}
