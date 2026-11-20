import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageDots, inViewport, radarOffset, replayPositions, samplesForReplay, stationObservation } from './radarAnalysis.js';

test('replay uses the last observation without bridging sampling gaps', () => {
  const first = { position_at: '2026-11-19T04:00:00Z', lon: 10 };
  const next = { position_at: '2026-11-19T04:01:00Z', lon: 11 };
  const routes = samplesForReplay([{ hex: 'abc123', segments: [[first], [next]] }]);
  const start = Date.parse(first.position_at);
  const at = (offset) => replayPositions(routes, start + offset, 'station');
  assert.deepEqual(at(-1), []);
  assert.equal(at(30000)[0].lon, 10);
  assert.deepEqual(at(30001), []);
  assert.deepEqual(at(60000), [{ ...next, hex: 'abc123', receiver_id: 'station', historical: true }]);
});

test('viewport and coverage handle the antimeridian', () => {
  const bounds = { west: 170, east: 190, south: -5, north: 5 };
  assert.equal(inViewport({ lat: 0, lon: -175 }, bounds), true);
  assert.equal(inViewport({ lat: 0, lon: 160 }, bounds), false);
  const observation = stationObservation({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
  assert.equal(observation.bearing, 90);
  assert.ok(observation.distance > 220 && observation.distance < 225);
});

test('polar chart puts north up and east right at the given radius', () => {
  assert.deepEqual([0, 90, 180, 270].map((bearing) => radarOffset(bearing, 10).map((n) => Math.round(n) || 0)),
    [[0, -10], [10, 0], [0, 10], [-10, 0]]);
});

test('short coverage ranges keep every point; long ranges keep the furthest sample per cell', () => {
  const points = Array.from({ length: 2000 }, () => ({ lat: 0, lon: 0.05, alt_baro: 1000 }));
  points.push({ lat: 0, lon: 0.0501, alt_baro: 2000 }, { lat: 0.1, lon: 0, alt_baro: 3000 });
  const routes = [{ segments: [points] }], receiver = { lat: 0, lon: 0 };
  const short = coverageDots(routes, receiver, 1800000, 131);
  assert.equal(short.dots.length, 2002);
  const long = coverageDots(routes, receiver, 3600000, 131);
  assert.equal(long.count, 2002);
  assert.deepEqual(long.dots.map(({ altitude }) => altitude), [2000, 3000]);
});
