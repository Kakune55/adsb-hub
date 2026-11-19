import { nearestLongitude } from './planeMotion.js';

export function windVector(metar, now = Date.now()) {
  const bearing = metar?.wdir;
  const knots = metar?.wspd;
  const age = now - Date.parse(metar?.reportTime);
  if (!Number.isFinite(age) || age < -300000 || age > 7200000 ||
      !Number.isFinite(bearing) || bearing < 0 || bearing > 360 || !Number.isFinite(knots) || knots <= 0) return null;
  // METAR names the direction the wind comes from; screen y grows southward.
  const radians = bearing * Math.PI / 180;
  return { x: -Math.sin(radians), y: Math.cos(radians), speed: Math.min(110, 12 + knots * 2.2) };
}

export function windBounds(project, location, runways) {
  const center = project(location);
  const north = project([location[0], location[1] + (location[1] > 0 ? -1 : 1) / 111.32]);
  const km = Math.hypot(center.x - north.x, center.y - north.y);
  const ends = (runways ?? []).flatMap(({ start, end }) => [start, end]).filter(Boolean);
  const points = ends.map(([lon, lat]) => project([nearestLongitude(location[0], lon), lat]));
  points.push(center);
  const margin = km * (ends.length >= 2 ? 0.8 : 2);
  return {
    left: Math.min(...points.map(({ x }) => x)) - margin,
    right: Math.max(...points.map(({ x }) => x)) + margin,
    top: Math.min(...points.map(({ y }) => y)) - margin,
    bottom: Math.max(...points.map(({ y }) => y)) + margin,
  };
}

export function animateAirportWind(map, canvas, airport, metar, runways) {
  const wind = windVector(metar);
  const ctx = canvas?.getContext('2d');
  if (!wind || !ctx || !airport) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const expires = Date.parse(metar.reportTime) + 7200000;
  const particles = [];
  let frame = 0, previous = 0, bounds, visible, count, dx, dy, ratio = 1;

  function clear() {
    cancelAnimationFrame(frame);
    frame = previous = 0;
    particles.length = 0;
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  }

  function draw(now) {
    if (Date.now() >= expires) { clear(); return; }
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
    previous = now;
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    ctx.strokeStyle = '#a3f8d9';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    const tail = 4 + wind.speed * 0.13;
    const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
    for (let i = 0; i < count; i++) {
      let p = particles[i];
      if (!p || p.life <= 0 || p.x < visible.left || p.x > visible.right || p.y < visible.top || p.y > visible.bottom) {
        p = particles[i] = {
          x: visible.left + Math.random() * (visible.right - visible.left),
          y: visible.top + Math.random() * (visible.bottom - visible.top),
          life: 0.5 + Math.random() * 1.8,
        };
      }
      p.x += dx * wind.speed * dt / width;
      p.y += dy * wind.speed * dt / height;
      p.life -= dt;
      const edge = Math.min(p.x, 1 - p.x, p.y, 1 - p.y);
      ctx.globalAlpha = 0.65 * Math.max(0, Math.min(1, edge * 8, p.life * 3));
      const x = bounds.left + p.x * width, y = bounds.top + p.y * height;
      ctx.beginPath();
      ctx.moveTo(x - dx * tail, y - dy * tail);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    frame = requestAnimationFrame(draw);
  }

  function refresh() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (document.hidden || reduced.matches || Date.now() >= expires || map.getZoom() < 11) {
      if (frame) clear();
      return;
    }
    bounds = windBounds((coordinates) => map.project(coordinates), [nearestLongitude(map.getCenter().lng, airport.lon), airport.lat], runways);
    const spanX = bounds.right - bounds.left, spanY = bounds.bottom - bounds.top;
    const left = Math.max(0, bounds.left), right = Math.min(width, bounds.right);
    const top = Math.max(0, bounds.top), bottom = Math.min(height, bounds.bottom);
    if (right <= left || bottom <= top) {
      if (frame) clear();
      return;
    }
    visible = { left: (left - bounds.left) / spanX, right: (right - bounds.left) / spanX,
      top: (top - bounds.top) / spanY, bottom: (bottom - bounds.top) / spanY };
    count = Math.min(120, Math.max(18, Math.round((right - left) * (bottom - top) / 4500)));
    const angle = map.getBearing() * Math.PI / 180;
    dx = wind.x * Math.cos(angle) + wind.y * Math.sin(angle);
    dy = wind.y * Math.cos(angle) - wind.x * Math.sin(angle);
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!frame) frame = requestAnimationFrame(draw);
  }

  map.on('move', refresh);
  map.on('resize', refresh);
  reduced.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
  return () => {
    map.off('move', refresh);
    map.off('resize', refresh);
    reduced.removeEventListener('change', refresh);
    document.removeEventListener('visibilitychange', refresh);
    clear();
  };
}
