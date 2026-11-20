export function samplesForReplay(routes) {
  return routes.map(({ hex, segments }) => ({ hex, samples: segments.flat().map((point) => ({
    point, at: Date.parse(point.position_at),
  })).filter(({ at }) => Number.isFinite(at)).sort((a, b) => a.at - b.at) })).filter(({ samples }) => samples.length);
}

export function replayPositions(routes, at, receiverID) {
  return routes.flatMap(({ hex, samples }) => {
    let lo = 0, hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].at <= at) lo = mid + 1;
      else hi = mid;
    }
    const sample = samples[lo - 1];
    return sample && at - sample.at <= 30000 ? [{ ...sample.point, hex, receiver_id: receiverID, historical: true }] : [];
  });
}

export function stationObservation(origin, point) {
  if (![origin?.lat, origin?.lon, point?.lat, point?.lon].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const a = origin.lat * rad, b = point.lat * rad, delta = (point.lon - origin.lon) * rad;
  const h = Math.sin((b - a) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(delta / 2) ** 2;
  return {
    distance: 12742 * Math.asin(Math.sqrt(Math.min(1, h))),
    bearing: (Math.atan2(Math.sin(delta) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta)) / rad + 360) % 360,
  };
}

export function inViewport(point, bounds) {
  if (!bounds || point.lat < bounds.south || point.lat > bounds.north) return false;
  const delta = ((point.lon - bounds.west) % 360 + 360) % 360;
  return delta <= bounds.east - bounds.west;
}

export function radarOffset(bearing, radius) {
  const angle = bearing * Math.PI / 180;
  return [Math.sin(angle) * radius, -Math.cos(angle) * radius];
}

export function coverageDots(routes, receiver, duration, radius) {
  const samples = [];
  let furthest = 0;
  for (const { segments } of routes) for (const segment of segments) for (const point of segment) {
    const observation = stationObservation(receiver, point);
    if (!observation) continue;
    furthest = Math.max(furthest, observation.distance);
    samples.push({ ...observation, altitude: point.on_ground ? 0 : point.alt_baro });
  }
  const max = Math.max(20, Math.ceil(furthest / 20) * 20);
  const merged = duration > 30 * 60 * 1000;
  const dots = [], cells = new Map();
  for (const { bearing, distance, altitude } of samples) {
    const [x, y] = radarOffset(bearing, radius * distance / max);
    if (!merged) {
      dots.push({ x, y, altitude });
      continue;
    }
    const key = `${Math.floor(x / 2)},${Math.floor(y / 2)}`;
    if (!cells.has(key) || distance > cells.get(key).distance) cells.set(key, { x, y, altitude, distance });
  }
  return { dots: merged ? [...cells.values()] : dots, count: samples.length, max, merged };
}
