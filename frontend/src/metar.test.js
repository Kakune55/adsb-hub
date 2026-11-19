import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRVR, parseMETAR } from './metar.js';

test('extracts RVR, metric visibility and cloud layers from the observation only', () => {
  const weather = parseMETAR('METAR ZHCC 190400Z 32010MPS 0800 R12L/0600U R12R/M0150V0800D FG FEW003 BKN006 TEMPO 0400 R30L/0400');
  assert.equal(weather.visibility, '800 m');
  assert.deepEqual(weather.rvr.map((range) => [range.runway, formatRVR(range)]), [['12L', '600 m ↑'], ['12R', '<150–800 m ↓']]);
  assert.deepEqual(weather.clouds.map(({ amount, feet }) => [amount, feet]), [['FEW', 300], ['BKN', 600]]);
  assert.deepEqual(weather.phenomena, ['FG']);
});

test('preserves US units, unknown cloud bases and unreported RVR', () => {
  const weather = parseMETAR('SPECI KJFK 190400Z 32010KT 1 1/2SM R04R/P6000FT VV/// RMK R04L/2000FT');
  assert.equal(weather.visibility, '1 1/2 SM');
  assert.equal(formatRVR(weather.rvr[0]), '>6000 ft');
  assert.equal(weather.rvr.length, 1);
  assert.equal(weather.clouds[0].feet, null);
  assert.deepEqual(parseMETAR('METAR ZHCC 190400Z 32010MPS CAVOK').rvr, []);
  assert.equal(parseMETAR('METAR ZHCC 190400Z 32010MPS 9999').visibility, '≥10 km');
});
