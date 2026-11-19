import React, { useEffect, useState } from 'react';

const endpoint = 'https://vrs-standing-data.adsb.lol/routes';

export function useReferenceRoute(flight) {
  const callsign = flight?.trim().toUpperCase();
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!/^[A-Z]{3}[A-Z0-9]{1,5}$/.test(callsign ?? '') || !/\d/.test(callsign)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(`${endpoint}/${callsign.slice(0, 2)}/${callsign}.json`, {
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    }).then((response) => response.ok ? response.json() : null).then((data) => {
      if (controller.signal.aborted || data?.callsign !== callsign || !Array.isArray(data._airports)) return;
      const airports = data._airports;
      if (airports.length < 2 || !airports.every((a) => a && /^[A-Z0-9]{4}$/.test(a.icao) &&
        Number.isFinite(a.lat) && Math.abs(a.lat) <= 90 && Number.isFinite(a.lon) && Math.abs(a.lon) <= 180)) return;
      setResult({ callsign, airports });
    }).catch(() => {}).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [callsign]);
  return result?.callsign === callsign ? result : null;
}

export function airportCode(airport) {
  return /^[A-Z0-9]{3}$/.test(airport.iata) ? airport.iata : airport.icao || airport.id;
}

export default function ReferenceRoute({ route, onLocate }) {
  if (!route) return null;
  return <section className="detail-section" aria-label="参考航线">
    <h2>参考航线 <a href="https://github.com/vradarserver/standing-data" target="_blank" rel="noreferrer">VRS</a></h2>
    <ol className="reference-airports">
      {route.airports.map((airport, i) => <li key={`${airport.icao}/${i}`}>
        <button type="button" onClick={() => onLocate(airport)} title="在地图上定位机场">
          <strong>{airportCode(airport)}</strong><span>{airport.name || airport.icao}</span>
        </button>
      </li>)}
    </ol>
  </section>;
}
