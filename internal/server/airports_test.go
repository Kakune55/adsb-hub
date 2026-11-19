package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAirportDirectory(t *testing.T) {
	const csv = `ident,icao_code,iata_code,type,name,latitude_deg,longitude_deg,elevation_ft,municipality,iso_country,scheduled_service
ZHCC,ZHCC,CGO,large_airport,Xinzheng,34.52,113.84,495,Zhengzhou,CN,yes
SM01,,,small_airport,Private,25,45,,,,no
SM02,,,small_airport,Scheduled,25,45,0,,,yes
BAD0,,,medium_airport,Invalid,NaN,45,,,,no`
	rows, err := parseAirports(strings.NewReader(csv))
	if err != nil || len(rows) != 2 || rows[0].IATA != "CGO" || rows[1].ID != "SM02" || rows[1].Elevation == nil || *rows[1].Elevation != 0 {
		t.Fatalf("unexpected directory records: %+v, %v", rows, err)
	}
}

func TestBundledAirportDirectory(t *testing.T) {
	w := httptest.NewRecorder()
	airportDirectory()(w, httptest.NewRequest(http.MethodGet, "/api/v1/airports", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"icao":"ZHCC","iata":"CGO"`) {
		t.Fatalf("bundled directory missing Zhengzhou airport (status %d)", w.Code)
	}
}
