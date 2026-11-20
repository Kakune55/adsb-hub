package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

type webFailures struct {
	count, strikes               int
	window, lockedUntil, expires time.Time
}

type webLockout struct {
	mu          sync.Mutex
	entries     map[string]webFailures
	nextCleanup time.Time
}

func (l *webLockout) attempt(ip string, submitted, valid bool, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !now.Before(l.nextCleanup) {
		for key, entry := range l.entries {
			if !now.Before(entry.expires) {
				delete(l.entries, key)
			}
		}
		l.nextCleanup = now.Add(time.Minute)
	}
	entry := l.entries[ip]
	if !now.Before(entry.expires) {
		entry = webFailures{}
	}
	if now.Before(entry.lockedUntil) {
		return entry.lockedUntil.Sub(now)
	}
	if valid {
		delete(l.entries, ip)
		return 0
	}
	if !submitted {
		return 0
	}
	if !now.Before(entry.window) {
		entry.count = 0
	}
	if entry.count == 0 {
		if len(l.entries) >= 4096 {
			if _, exists := l.entries[ip]; !exists {
				return l.nextCleanup.Sub(now)
			}
		}
		entry.window = now.Add(10 * time.Minute)
		if entry.strikes == 0 {
			entry.expires = entry.window
		}
	}
	entry.count++
	var wait time.Duration
	if entry.count >= 3 {
		wait = min(5*time.Minute<<entry.strikes, time.Hour)
		entry.strikes = min(entry.strikes+1, 4)
		entry.count = 0
		entry.window = time.Time{}
		entry.lockedUntil = now.Add(wait)
		entry.expires = entry.lockedUntil.Add(24 * time.Hour)
	}
	l.entries[ip] = entry
	return wait
}

func webClientIP(r *http.Request, trusted map[netip.Addr]bool) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if trusted[peer] {
		headers := r.Header.Values("X-Forwarded-For")
		// Walk from the socket towards the client, stopping at the first untrusted hop.
		for i := len(headers) - 1; i >= 0; i-- {
			hops := strings.Split(headers[i], ",")
			for j := len(hops) - 1; j >= 0; j-- {
				addr, err := netip.ParseAddr(strings.TrimSpace(hops[j]))
				if err != nil || addr.Zone() != "" {
					return peer.String()
				}
				addr = addr.Unmap()
				if !trusted[addr] {
					return addr.String()
				}
			}
		}
	}
	return peer.String()
}

func protectWeb(next http.Handler, user, password string, trusted map[netip.Addr]bool) http.Handler {
	if user == "" && password == "" {
		return next
	}
	wantUser, wantPassword := sha256.Sum256([]byte(user)), sha256.Sum256([]byte(password))
	lockout := webLockout{entries: make(map[string]webFailures)}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only the ingest handler authenticates collector bearer tokens.
		if r.Method == http.MethodPost && r.URL.EscapedPath() == "/api/v1/ingest" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		u, p, ok := r.BasicAuth()
		gotUser, gotPassword := sha256.Sum256([]byte(u)), sha256.Sum256([]byte(p))
		valid := ok && subtle.ConstantTimeCompare(gotUser[:], wantUser[:])&subtle.ConstantTimeCompare(gotPassword[:], wantPassword[:]) == 1
		ip := webClientIP(r, trusted)
		scheme, _, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if wait := lockout.attempt(ip, strings.EqualFold(scheme, "Basic"), valid, time.Now()); wait > 0 {
			seconds := int((wait + time.Second - 1) / time.Second)
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			http.Error(w, "too many failed login attempts; try again later", http.StatusTooManyRequests)
			return
		}
		if !valid {
			w.Header().Set("WWW-Authenticate", `Basic realm="ADS-B Hub", charset="UTF-8"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
