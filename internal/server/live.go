package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type liveFrame struct {
	Points    []Point   `json:"points"`
	ServerAt  time.Time `json:"server_time"`
	MaxAgeSec int       `json:"max_age_seconds"`
}

type liveSubscription struct {
	receiver string
	batches  chan []Point
	done     chan struct{}
}

type liveStreams struct {
	mu   sync.Mutex
	subs map[*liveSubscription]struct{}
}

func (s *liveStreams) subscribe(receiver string) *liveSubscription {
	sub := &liveSubscription{receiver, make(chan []Point, 16), make(chan struct{})}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.subs == nil {
		s.subs = make(map[*liveSubscription]struct{})
	}
	s.subs[sub] = struct{}{}
	return sub
}

func (s *liveStreams) publish(receiver string, points []Point) {
	if len(points) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for sub := range s.subs {
		if sub.receiver != "" && sub.receiver != receiver {
			continue
		}
		select {
		case sub.batches <- points:
		default:
			// Reconnect with a fresh snapshot rather than silently losing updates.
			delete(s.subs, sub)
			close(sub.done)
		}
	}
}

type liveKey struct{ receiver, hex string }

func newerPoint(p, previous Point) bool {
	if !p.At.Equal(previous.At) {
		return p.At.After(previous.At)
	}
	if !p.IngestedAt.Equal(previous.IngestedAt) {
		return p.IngestedAt.After(previous.IngestedAt)
	}
	return p.eventID > previous.eventID
}

func (s *liveStreams) serve(w http.ResponseWriter, r *http.Request, shutdown <-chan struct{}, snapshot func(context.Context, string) (liveFrame, error)) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	receiver := r.URL.Query().Get("receiver_id")
	// Subscribe before reading PostgreSQL so commits during the query are not missed.
	sub := s.subscribe(receiver)
	defer func() {
		s.mu.Lock()
		delete(s.subs, sub)
		s.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	frame, err := snapshot(ctx, receiver)
	cancel()
	if err != nil {
		dbError(w, err)
		return
	}
	latest := make(map[liveKey]Point, len(frame.Points))
	for _, p := range frame.Points {
		latest[liveKey{p.ReceiverID, p.Hex}] = p
	}
	maxAge := time.Duration(frame.MaxAgeSec) * time.Second
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	response := http.NewResponseController(w)
	if err := writeLiveEvent(w, response, "snapshot", frame); err != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-shutdown:
			return
		case <-sub.done:
			return
		case <-heartbeat.C:
			cutoff := time.Now().Add(-maxAge)
			for key, p := range latest {
				if !p.At.After(cutoff) {
					delete(latest, key)
				}
			}
			if err := writeLiveEvent(w, response, "", liveFrame{}); err != nil {
				return
			}
		case points := <-sub.batches:
			now := time.Now().UTC()
			delta := liveFrame{ServerAt: now, MaxAgeSec: frame.MaxAgeSec}
			for _, p := range points {
				if !p.At.After(now.Add(-maxAge)) || p.At.After(now) {
					continue
				}
				key := liveKey{p.ReceiverID, p.Hex}
				if previous, exists := latest[key]; !exists || newerPoint(p, previous) {
					latest[key] = p
					delta.Points = append(delta.Points, p)
				}
			}
			if len(delta.Points) > 0 && writeLiveEvent(w, response, "positions", delta) != nil {
				return
			}
		}
	}
}

func writeLiveEvent(w http.ResponseWriter, response *http.ResponseController, name string, frame liveFrame) error {
	if err := response.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if name == "" {
		if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
			return err
		}
	} else {
		data, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
			return err
		}
	}
	if err := response.Flush(); err != nil {
		return err
	}
	return response.SetWriteDeadline(time.Time{})
}
