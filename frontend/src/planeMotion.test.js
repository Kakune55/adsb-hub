import assert from 'node:assert/strict';
import test from 'node:test';
import { interpolatePosition, isUncertainTrailLeg, motionDuration, nearestLongitude } from './planeMotion.js';

test('position interpolation takes the short path across the antimeridian and stops at the sample', () => {
  const from = { lat: 30, lng: 179 };
  const to = { lat: 32, lng: nearestLongitude(from.lng, -179) };
  assert.deepEqual(interpolatePosition(from, to, 0.5), [31, 180]);
  assert.deepEqual(interpolatePosition(from, to, 2), [32, 181]);
  assert.equal(nearestLongitude(-179, 179), -181);
});

test('smooths recent nearby updates with a bounded duration, but snaps after a gap or a large jump', () => {
  assert.equal(motionDuration(25, 100), 120);
  assert.equal(motionDuration(250, 100), 250);
  assert.equal(motionDuration(1000, 100), 450);
  assert.equal(motionDuration(8001, 100), 0);
  assert.equal(motionDuration(1000, 10001), 0);
});

test('marks trail links with either a long sample gap or a large displacement as uncertain', () => {
  assert.equal(isUncertainTrailLeg(30000, 10000), false);
  assert.equal(isUncertainTrailLeg(30001, 100), true);
  assert.equal(isUncertainTrailLeg(1000, 10001), true);
});
