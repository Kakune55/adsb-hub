package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"adsb-hub/internal/event"
)

func TestLiveStreamSnapshotAndUpdates(t *testing.T) {
	streams := &liveStreams{}
	now := time.Now().UTC()
	point := Point{ReceiverID: "a", Position: event.Position{Hex: "abc123", At: now.Add(-2 * time.Second)}, IngestedAt: now}
	older, newer, expired, foreign := point, point, point, point
	older.At = now.Add(-3 * time.Second)
	newer.At = now.Add(-time.Second)
	expired.At, expired.Hex = now.Add(-2*time.Minute), "000000"
	foreign.ReceiverID = "b"
	shutdown := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		streams.serve(w, r, shutdown, func(_ context.Context, _ string) (liveFrame, error) {
			// Exercise updates received before the initial snapshot has been sent.
			streams.publish("a", []Point{older, point, expired})
			streams.publish("b", []Point{foreign})
			streams.publish("a", []Point{newer})
			return liveFrame{[]Point{point}, now, 60}, nil
		})
	}))
	defer server.Close()
	defer close(shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"?receiver_id=a", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("unexpected response: %s %v", response.Status, response.Header)
	}
	scanner := bufio.NewScanner(response.Body)
	for _, want := range []struct {
		name string
		at   time.Time
	}{{"snapshot", point.At}, {"positions", newer.At}} {
		if !scanner.Scan() || scanner.Text() != "event: "+want.name {
			t.Fatalf("expected %s, got %q (%v)", want.name, scanner.Text(), scanner.Err())
		}
		if !scanner.Scan() || !strings.HasPrefix(scanner.Text(), "data: ") {
			t.Fatalf("missing event data: %q (%v)", scanner.Text(), scanner.Err())
		}
		var frame liveFrame
		if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &frame); err != nil {
			t.Fatal(err)
		}
		if len(frame.Points) != 1 || frame.Points[0].ReceiverID != "a" || !frame.Points[0].At.Equal(want.at) || frame.MaxAgeSec != 60 {
			t.Fatalf("unexpected %s: %+v", want.name, frame)
		}
		if !scanner.Scan() || scanner.Text() != "" {
			t.Fatal("missing event separator")
		}
	}
}

func TestLiveStreamsDisconnectSlowSubscriber(t *testing.T) {
	streams := &liveStreams{}
	slow := streams.subscribe("a")
	fast := streams.subscribe("a")
	for range cap(slow.batches) + 1 {
		streams.publish("a", []Point{{ReceiverID: "a"}})
		select {
		case <-fast.batches:
		default:
			t.Fatal("fast subscriber missed a batch")
		}
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("slow subscriber was not disconnected")
	}
}
