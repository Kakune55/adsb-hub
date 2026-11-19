export function nearestLongitude(from, to) {
  return to + 360 * Math.round((from - to) / 360);
}

export function motionDuration(sampleGap, distance) {
  if (!Number.isFinite(sampleGap) || sampleGap < 0 || sampleGap > 8000 || distance > 10000) return 0;
  return Math.max(120, Math.min(450, sampleGap));
}

export function isUncertainTrailLeg(sampleGap, distance) {
  return sampleGap > 30000 || distance > 10000;
}

export function interpolatePosition(from, to, progress) {
  const t = Math.max(0, Math.min(1, progress));
  return [from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t];
}
