import assert from 'node:assert/strict';
import test from 'node:test';
import { windBounds, windVector } from './airportWind.js';

const now = Date.parse('2026-11-19T04:00:00Z');
const metar = { reportTime: new Date(now).toISOString(), wdir: 90, wspd: 10 };

test('METAR easterly blows west and stronger wind moves faster', () => {
  const wind = windVector(metar, now);
  assert.equal(wind.x, -1);
  assert.ok(Math.abs(wind.y) < 1e-9);
  assert.ok(windVector({ ...metar, wspd: 20 }, now).speed > wind.speed);
});

test('calm, variable, expired, or undated observations do not animate', () => {
  assert.equal(windVector({ ...metar, wspd: 0 }, now), null);
  assert.equal(windVector({ ...metar, wdir: 'VRB' }, now), null);
  assert.equal(windVector(metar, now + 7200001), null);
  assert.equal(windVector({ ...metar, reportTime: null }, now), null);
});

test('wind coverage includes runway ends and grows with map zoom', () => {
  const project = ([lon, lat]) => ({ x: lon * 1000, y: -lat * 1000 });
  const runways = [{ start: [-0.03, 0.01], end: [0.04, -0.01] }];
  const bounds = windBounds(project, [0, 0], runways);
  assert.ok(bounds.left < -30 && bounds.right > 40);
  assert.ok(bounds.top < -10 && bounds.bottom > 10);
  const zoomed = windBounds(([lon, lat]) => project([lon * 2, lat * 2]), [0, 0], runways);
  assert.deepEqual(zoomed, Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value * 2])));
  const fallback = windBounds(project, [0, 0], []);
  assert.ok(fallback.right > 17 && fallback.left < -17);
});
