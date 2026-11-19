package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAircraftDirectory(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/7808A7":
			fmt.Fprint(w, `{"response":{"aircraft":{"registration":"B-6917","icao_type":"A321","url_photo":"https://example.com/photo.jpg"}}}`)
		case "/ABC123":
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusTooManyRequests)
		}
	}))
	defer upstream.Close()
	d := newAircraftDirectory(upstream.URL + "/")
	for _, tc := range []struct {
		hex    string
		status int
		body   string
		hits   int32
	}{
		{"~7808a7", 400, "ICAO", 0},
		{"7808a7", 200, "B-6917", 1},
		{"7808A7", 200, "B-6917", 1},
		{"abc123", 200, "null", 2},
		{"ABC123", 200, "null", 2},
		{"def456", 503, "unavailable", 3},
		{"def456", 503, "unavailable", 4},
	} {
		w := httptest.NewRecorder()
		d.serve(w, httptest.NewRequest(http.MethodGet, "/api/v1/aircraft/info?hex="+tc.hex, nil))
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.body) || strings.Contains(w.Body.String(), "url_photo") || hits.Load() != tc.hits {
			t.Fatalf("hex %s: status %d, body %q, upstream hits %d", tc.hex, w.Code, w.Body.String(), hits.Load())
		}
	}
}
