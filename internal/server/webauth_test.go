package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestProtectWeb(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/ingest", (api{}).ingest)
	mux.HandleFunc("GET /api/v1/airports", airportDirectory())
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	protected := protectWeb(mux, "viewer", "test-password", nil)
	for _, tc := range []struct {
		method, path, password string
		code                   int
		challenge              bool
	}{
		{"GET", "/", "", 401, true},
		{"HEAD", "/assets/app.js", "", 401, true},
		{"GET", "/api/v1/live/stream", "wrong", 401, true},
		{"GET", "/api/v1/airports", "test-password", 200, false},
		{"POST", "/api/v1/%69ngest", "", 401, true},
		{"GET", "/api/v1/ingest", "", 401, true},
		{"POST", "/api/v1/ingest", "test-password", 401, false},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.password != "" {
			r.SetBasicAuth("viewer", tc.password)
		}
		w := httptest.NewRecorder()
		protected.ServeHTTP(w, r)
		if w.Code != tc.code || (w.Header().Get("WWW-Authenticate") != "") != tc.challenge ||
			(tc.path == "/api/v1/airports" && w.Header().Get("Cache-Control") != "no-store") {
			t.Errorf("%s %s: got status %d, headers %v", tc.method, tc.path, w.Code, w.Header())
		}
	}
}

func TestWebLockoutTiming(t *testing.T) {
	l := webLockout{entries: make(map[string]webFailures)}
	now := time.Unix(1000, 0)
	for i := 0; i < 4; i++ {
		if got := l.attempt("a", false, false, now); got != 0 {
			t.Fatalf("missing credentials counted: %v", got)
		}
	}
	for i := 0; i < 2; i++ {
		if got := l.attempt("a", true, false, now); got != 0 {
			t.Fatalf("locked too early: %v", got)
		}
	}
	if got := l.attempt("a", true, false, now); got != 5*time.Minute {
		t.Fatalf("third failure lock duration = %v", got)
	}
	if got := l.attempt("a", true, true, now.Add(time.Minute)); got != 4*time.Minute {
		t.Fatalf("valid credentials bypassed lock or extended it: %v", got)
	}
	if got := l.attempt("b", true, true, now); got != 0 {
		t.Fatalf("other IP was locked: %v", got)
	}
	if got := l.attempt("a", true, true, now.Add(5*time.Minute)); got != 0 {
		t.Fatalf("lock did not expire: %v", got)
	}
	l.attempt("b", true, false, now)
	l.attempt("b", true, false, now)
	l.attempt("b", true, true, now)
	if got := l.attempt("b", true, false, now); got != 0 {
		t.Fatalf("successful login did not clear failures: %v", got)
	}
	l.attempt("c", true, false, now)
	l.attempt("c", true, false, now)
	if got := l.attempt("c", true, false, now.Add(10*time.Minute)); got != 0 {
		t.Fatalf("expired failures were counted: %v", got)
	}
}

func TestProtectWebLockoutResponse(t *testing.T) {
	protected := protectWeb(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), "viewer", "test-password", nil)
	for i, want := range []int{401, 401, 429, 429} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/live", nil)
		r.RemoteAddr = "192.0.2.1:1234"
		r.Header.Set("X-Forwarded-For", string(rune('a'+i)))
		r.SetBasicAuth("viewer", "wrong")
		if i == 3 {
			r.SetBasicAuth("viewer", "test-password")
		}
		w := httptest.NewRecorder()
		protected.ServeHTTP(w, r)
		if w.Code != want || (want == 429 && w.Header().Get("Retry-After") == "") {
			t.Fatalf("attempt %d: status %d, headers %v", i+1, w.Code, w.Header())
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", nil)
	r.RemoteAddr = "192.0.2.1:1234"
	w := httptest.NewRecorder()
	protected.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("ingest affected by web lockout: %d", w.Code)
	}
}

func TestWebLockoutBackoff(t *testing.T) {
	l := webLockout{entries: make(map[string]webFailures)}
	now := time.Unix(1000, 0)
	for _, minutes := range []int{5, 10, 20, 40, 60, 60} {
		for i := 0; i < 2; i++ {
			if got := l.attempt("a", true, false, now); got != 0 {
				t.Fatalf("locked too early: %v", got)
			}
		}
		want := time.Duration(minutes) * time.Minute
		if got := l.attempt("a", true, false, now); got != want {
			t.Fatalf("lock = %v; want %v", got, want)
		}
		now = now.Add(want)
	}
	l.attempt("a", true, true, now)
	l.attempt("a", true, false, now)
	l.attempt("a", true, false, now)
	if got := l.attempt("a", true, false, now); got != 5*time.Minute {
		t.Fatalf("successful login did not reset backoff: %v", got)
	}
}

func TestWebClientIP(t *testing.T) {
	trusted := map[netip.Addr]bool{netip.MustParseAddr("192.0.2.10"): true, netip.MustParseAddr("192.0.2.11"): true}
	for _, tc := range []struct{ peer, forwarded, want string }{
		{"192.0.2.20:1234", "198.51.100.3", "192.0.2.20"},
		{"192.0.2.10:1234", "198.51.100.3, 198.51.100.4, 192.0.2.11", "198.51.100.4"},
		{"[::ffff:192.0.2.10]:1234", "2001:db8::1", "2001:db8::1"},
		{"192.0.2.10:1234", "198.51.100.3, malformed", "192.0.2.10"},
		{"192.0.2.10:1234", "", "192.0.2.10"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		if got := webClientIP(r, trusted); got != tc.want {
			t.Errorf("peer %s, forwarded %q: got %s, want %s", tc.peer, tc.forwarded, got, tc.want)
		}
	}
}
