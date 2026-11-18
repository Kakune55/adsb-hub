package collector

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"adsb-hub/internal/event"
)

type Config struct {
	TCPAddr, ReadsbDir, QueuePath, IngestURL, Token string
	QueueLimit                                      int
	Lat, Lon                                        *float64
}

func Run(ctx context.Context, cfg Config) error {
	db, err := openQueue(cfg.QueuePath)
	if err != nil {
		return fmt.Errorf("open SQLite queue: %w", err)
	}
	defer db.Close()
	log.Printf("collector reading %s, queue %s (limit %d)", cfg.TCPAddr, cfg.QueuePath, cfg.QueueLimit)
	records := make(chan event.Event, event.UploadBatchSize)
	var sources sync.WaitGroup
	sources.Go(func() { readStream(ctx, cfg.TCPAddr, records) })
	sources.Go(func() { sampleFiles(ctx, cfg, records) })
	go func() {
		sources.Wait()
		close(records)
	}()
	var uploader sync.WaitGroup
	uploader.Go(func() { uploadLoop(ctx, db, cfg) })
	writeLoop(ctx, db, records, cfg.QueueLimit)
	uploader.Wait()
	return nil
}

func receive(ctx context.Context, out chan<- event.Event, record event.Event) {
	record.ID = rand.Text()
	select {
	case out <- record:
	case <-ctx.Done():
	}
}

func readStream(ctx context.Context, addr string, out chan<- event.Event) {
	dialer := net.Dialer{Timeout: 5 * time.Second}
	for ctx.Err() == nil {
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err == nil {
			log.Printf("connected to readsb at %s", addr)
			err = scanStream(ctx, conn, out)
		}
		if ctx.Err() == nil {
			log.Printf("readsb TCP: %v (reconnecting)", err)
			pause(ctx, 2*time.Second)
		}
	}
}

func scanStream(ctx context.Context, conn net.Conn, out chan<- event.Event) error {
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		if len(bytes.TrimSpace(scanner.Bytes())) == 0 {
			continue
		}
		position, err := readPosition(scanner.Bytes(), time.Now().UTC())
		if err != nil {
			log.Printf("readsb position: %v", err)
		} else if position != nil {
			receive(ctx, out, event.Event{Position: position})
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.EOF
}

func sampleFiles(ctx context.Context, cfg Config, out chan<- event.Event) {
	sample := func(source string) {
		data, err := readSample(filepath.Join(cfg.ReadsbDir, source+".json"), source)
		if err != nil {
			log.Printf("readsb %s.json: %v", source, err)
			return
		}
		if source == "receiver" && cfg.Lat != nil {
			data.Lat, data.Lon = cfg.Lat, cfg.Lon
		}
		receive(ctx, out, event.Event{Sample: data})
	}
	sample("receiver")
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for ctx.Err() == nil {
		sample("stats")
		sample("status")
		select {
		case <-ticker.C:
		case <-ctx.Done():
		}
	}
}

func writeLoop(ctx context.Context, db *sql.DB, in <-chan event.Event, limit int) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	batch := make([]event.Event, 0, event.UploadBatchSize)
	flush := func() {
		for len(batch) > 0 {
			writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			added, err := enqueue(writeCtx, db, batch, limit)
			cancel()
			if err == nil {
				if added < len(batch) {
					log.Printf("WARNING: SQLite queue full (limit %d); rejected %d new events", limit, len(batch)-added)
				}
				batch = batch[:0]
				return
			}
			log.Printf("SQLite queue write: %v", err)
			if !pause(ctx, time.Second) {
				log.Printf("WARNING: could not persist %d buffered events before shutdown", len(batch))
				batch = batch[:0]
				return
			}
		}
	}
	for {
		select {
		case record, ok := <-in:
			if !ok {
				flush()
				return
			}
			batch = append(batch, record)
			if len(batch) == cap(batch) {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func uploadLoop(ctx context.Context, db *sql.DB, cfg Config) {
	client := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	delay := time.Second
	for ctx.Err() == nil {
		batch, lastID, err := oldest(ctx, db)
		if err == nil && len(batch) == 0 {
			pause(ctx, time.Second)
			continue
		}
		if err == nil {
			err = postBatch(ctx, client, cfg, batch)
		}
		if err == nil {
			_, err = db.ExecContext(ctx, `DELETE FROM queue WHERE id <= ?`, lastID)
		}
		if err == nil {
			delay = time.Second
		} else if ctx.Err() == nil {
			log.Printf("upload: %v (queue retained, retry in %s)", err, delay)
			pause(ctx, delay)
			delay = min(delay*2, time.Minute)
		}
	}
}

func postBatch(ctx context.Context, client *http.Client, cfg Config, batch []json.RawMessage) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.IngestURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("server returned %s", resp.Status)
	}
	return nil
}

func pause(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
