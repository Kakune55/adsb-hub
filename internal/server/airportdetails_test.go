package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAirportDetails(t *testing.T) {
	w := httptest.NewRecorder()
	airportDetails()(w, httptest.NewRequest(http.MethodGet, "/api/v1/airports/details?id=ZHCC", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"low":"12L"`) || !strings.Contains(w.Body.String(), `"type":"TWR"`) {
		t.Fatalf("missing runway or tower data: %d %s", w.Code, w.Body.String())
	}
}

func TestAirportWeather(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ids") != "ZHCC" {
			t.Errorf("unexpected ICAO: %s", r.URL)
		}
		if r.URL.Path == "/taf" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = w.Write([]byte(`[{"icaoId":"OTHER","temp":50},{"icaoId":"ZHCC","temp":0,"wdir":"VRB","rawOb":"METAR ZHCC"}]`))
	}))
	defer upstream.Close()
	serve := airportWeather(upstream.URL + "/")
	for _, tc := range []struct {
		query  string
		status int
		body   string
	}{
		{"icao=zhcc&kind=metar", 200, `"temp":0`},
		{"icao=ZHCC&kind=taf", 200, "null"},
		{"icao=ZHCC&kind=other", 400, "invalid"},
	} {
		w := httptest.NewRecorder()
		serve(w, httptest.NewRequest(http.MethodGet, "/?"+tc.query, nil))
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.body) {
			t.Fatalf("unexpected response for %s: %d %s", tc.query, w.Code, w.Body.String())
		}
	}
}
