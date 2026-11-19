import React, { useEffect, useRef, useState } from 'react';
import { Map as GLMap, LngLat, LngLatBounds, NavigationControl, Popup, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { altitudeColor } from './altitude.js';
import { animateAirportWind } from './airportWind.js';
import { formatRVR, parseMETAR } from './metar.js';
import { airportCode } from './ReferenceRoute.jsx';
import { interpolatePosition, isUncertainTrailLeg, motionDuration, nearestLongitude } from './planeMotion.js';

setWorkerUrl(workerUrl);

const storageKey = 'adsb-hub.basemap';
const darkStyle = 'https://tiles.openfreemap.org/styles/dark';
const satelliteStyle = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri World Imagery</a> · Esri, Vantor, Earthstar Geographics, GIS User Community',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0d1727' } },
    { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-saturation': -.45, 'raster-brightness-max': .66 } },
  ],
};
const collection = (features = []) => ({ type: 'FeatureCollection', features });
const feature = (type, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
const position = ({ lat, lon }) => [lon, lat];
const pointColor = (p) => altitudeColor(p.on_ground ? 0 : p.alt_baro);
const isPoint = ['==', ['geometry-type'], 'Point'];
const isLine = ['==', ['geometry-type'], 'LineString'];
const airportLayers = ['route-airports', 'large-airports', 'regional-airports'];
const hoverLayers = ['planes', 'last-known', 'receiver', ...airportLayers];
const pickLayers = ['planes', ...airportLayers, 'history-line', 'history-gap', 'history-dot'];

function trailData(tracks) {
  const features = [];
  tracks.forEach(({ segments }, route) => segments.forEach((samples, segment) => {
    const props = { route, segment };
    let previous, previousTime, run;
    for (const p of samples) {
      const coord = position(p), color = pointColor(p);
      const time = Date.parse(p.position_at);
      if (previous) coord[0] = nearestLongitude(previous[0], coord[0]);
      features.push(feature('Point', coord, props));
      if (previous) {
        const uncertain = isUncertainTrailLeg(time - previousTime, new LngLat(...previous).distanceTo(new LngLat(...coord)));
        if (!run || run.properties.color !== color || run.properties.uncertain !== uncertain) {
          run = feature('LineString', [previous], { ...props, color, uncertain });
          features.push(run);
        }
        run.geometry.coordinates.push(coord);
      }
      previous = coord;
      previousTime = time;
    }
  }));
  return collection(features);
}

function receiverData(lon, lat) {
  const radians = Math.PI / 180;
  const phi = lat * radians;
  const rings = [50, 100, 200].flatMap((km) => {
    const distance = km / 6371;
    const coordinates = Array.from({ length: 73 }, (_, i) => {
      const bearing = i * Math.PI / 36;
      const y = Math.asin(Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(bearing));
      const x = Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(phi), Math.cos(distance) - Math.sin(phi) * Math.sin(y));
      return [lon + x / radians, y / radians];
    });
    return [feature('LineString', coordinates), feature('Point', coordinates[8], { radiusLabel: `${km} km` })];
  });
  return collection([...rings, feature('Point', [lon, lat], { label: '接收基站' })]);
}

function nearestSample(map, cursor, history, hits) {
  let best, distance = 9;
  const world = map.unproject(cursor).lng;
  const visited = new Set();
  for (const { properties: { route, segment } } of hits) {
    const key = `${route}/${segment}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const track = history[route], samples = track?.segments[segment];
    if (!samples) continue;
    let previous, previousDistance;
    samples.forEach((sample, index) => {
      const screen = map.project([nearestLongitude(world, sample.lon), sample.lat]);
      const pointDistance = cursor.dist(screen);
      let hit = pointDistance;
      if (previous) {
        const dx = screen.x - previous.x, dy = screen.y - previous.y;
        const t = Math.max(0, Math.min(1, ((cursor.x - previous.x) * dx + (cursor.y - previous.y) * dy) / (dx * dx + dy * dy || 1)));
        hit = Math.hypot(cursor.x - previous.x - dx * t, cursor.y - previous.y - dy * t);
      }
      if (hit < distance) {
        distance = hit;
        best = { ...(previous && previousDistance <= pointDistance ? samples[index - 1] : sample), hex: track.hex };
      }
      previous = screen;
      previousDistance = pointDistance;
    });
  }
  return best;
}

function aircraftImage() {
  const canvas = document.createElement('canvas');
  const size = canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 4, 4);
  ctx.fill(new Path2D('M14 2c1 0 2 1.7 2 4v5l9 6v2l-9-3v5l4 3v2l-6-2-6 2v-2l4-3v-5l-9 3v-2l9-6V6c0-2.3 1-4 2-4Z'));
  const mask = ctx.getImageData(0, 0, size, size).data;
  const data = new Uint8Array(size * size * 4);
  // One signed-distance icon supports data-driven color and outlines in the shader.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const inside = mask[i + 3] >= 128;
    let squared = 36;
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      const nx = x + dx, ny = y + dy, d = dx * dx + dy * dy;
      if (d >= squared || nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
      if ((mask[(ny * size + nx) * 4 + 3] >= 128) !== inside) squared = d;
    }
    const distance = Math.sqrt(squared) - 0.5;
    data[i + 3] = Math.max(0, Math.min(255, Math.round(255 * (.75 + (inside ? distance : -distance) / 6))));
  }
  return { width: size, height: size, data };
}

function towerImage() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.fillStyle = '#13283b';
  ctx.strokeStyle = '#94c5ee';
  ctx.beginPath();
  ctx.arc(10, 10, 9, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#d8efff';
  ctx.fill(new Path2D('M5 5h10l-1.5 4H11l1 6h2v1H6v-1h2l1-6H6.5Z'));
  return ctx.getImageData(0, 0, 40, 40);
}

function addRadarLayers(map, sources, icon, tower) {
  for (const [id, data] of Object.entries(sources)) map.addSource(id, { type: 'geojson', data });
  map.addLayer({ id: 'airport-runways', source: 'airport-runways', type: 'symbol', minzoom: 11,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 13,
      'text-overlap': 'cooperative', 'text-ignore-placement': true },
    paint: { 'text-color': ['case', ['get', 'closed'], '#d9afa7', '#a3f8d9'],
      'text-halo-color': '#101a2b', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'airport-runway-rvr', source: 'airport-runways', type: 'symbol', minzoom: 12,
    filter: ['has', 'rvr'],
    layout: { 'text-field': ['get', 'rvr'], 'text-font': ['Noto Sans Regular'], 'text-size': 10,
      'text-anchor': 'top', 'text-offset': [0, 0.95], 'text-padding': 4, 'text-ignore-placement': true },
    paint: { 'text-color': '#f6ce96', 'text-halo-color': '#101a2b', 'text-halo-width': 1.5 } }, 'airport-runways');
  for (const [id, focused] of [['history', false], ['track', true]]) {
    for (const uncertain of [false, true]) {
      map.addLayer({ id: `${id}-${uncertain ? 'gap' : 'line'}`, source: id, type: 'line',
        filter: ['all', isLine, ['==', ['get', 'uncertain'], uncertain]],
        layout: { 'line-join': 'round', 'line-cap': uncertain ? 'butt' : 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': focused ? 3 : 2, 'line-opacity': focused ? .95 : .66,
          ...(uncertain && { 'line-dasharray': [2, 2] }) } });
    }
    map.addLayer({ id: `${id}-dot`, source: id, type: 'circle', filter: isPoint,
      paint: { 'circle-color': '#fff', 'circle-radius': focused ? 1.7 : 1.3, 'circle-opacity': focused ? .62 : .42 } });
  }
  map.addLayer({ id: 'receiver-rings', source: 'receiver', type: 'line', filter: isLine,
    paint: { 'line-color': '#76bdfa', 'line-opacity': .4, 'line-dasharray': [4, 7] } });
  map.addLayer({ id: 'receiver-ring-labels', source: 'receiver', type: 'symbol',
    filter: ['all', isPoint, ['has', 'radiusLabel']],
    layout: { 'text-field': ['get', 'radiusLabel'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
      'text-overlap': 'cooperative', 'text-ignore-placement': true },
    paint: { 'text-color': '#b9ddff', 'text-halo-color': '#101a2b', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'receiver', source: 'receiver', type: 'circle', filter: ['all', isPoint, ['has', 'label']],
    paint: { 'circle-color': '#509ce8', 'circle-stroke-color': '#cce7ff', 'circle-stroke-width': 2, 'circle-radius': 5 } });
  map.addLayer({ id: 'last-known', source: 'last-known', type: 'circle',
    paint: { 'circle-color': '#182638', 'circle-stroke-color': '#ffc875', 'circle-stroke-width': 2, 'circle-radius': 7 } });
  map.addImage('airport-tower', tower, { pixelRatio: 2 });
  for (const [id, minzoom, filter] of [
    ['large-airports', 3, ['==', ['get', 'kind'], 'large_airport']],
    ['regional-airports', 7, ['!=', ['get', 'kind'], 'large_airport']],
    ['route-airports', 0, null],
  ]) {
    const route = id === 'route-airports';
    map.addLayer({ id, source: route ? id : 'airports', type: 'symbol', minzoom, ...(filter && { filter }),
      layout: { 'icon-image': 'airport-tower', 'icon-size': route ? 1.1 : 0.8, 'icon-ignore-placement': true,
        'icon-overlap': route ? 'always' : 'cooperative', 'text-field': route ? ['get', 'code'] : ['step', ['zoom'], '', 7, ['get', 'code']],
        'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-anchor': 'left', 'text-offset': [1, 0],
        'text-optional': true, 'text-ignore-placement': true },
      paint: { 'text-color': route ? '#a3f8d9' : '#b9ddff', 'text-halo-color': '#101a2b', 'text-halo-width': 1.5 } });
  }
  map.addImage('radar-aircraft', icon, { sdf: true, pixelRatio: 2 });
  map.addLayer({ id: 'planes', source: 'planes', type: 'symbol',
    layout: { 'icon-image': 'radar-aircraft', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-rotation-alignment': 'map', 'icon-rotate': ['get', 'heading'],
      'symbol-sort-key': ['get', 'selected'], 'icon-size': ['case', ['==', ['get', 'selected'], 1], 1, .85] },
    paint: { 'icon-color': ['get', 'color'], 'icon-halo-width': 1,
      'icon-halo-color': ['case', ['==', ['get', 'selected'], 1], '#f2f5fb', '#07111d'] } });
}

export default function MapView({ station, points, track, selectedHex, lastKnown, pan, historyTracks, onSelect, followKey, onFollow, onStopFollowing, referenceRoute, airports, onAirportSelect, airportRunways, selectedAirport, airportMETAR }) {
  const element = useRef(null);
  const windCanvas = useRef(null);
  const radar = useRef(null);
  const current = useRef(null);
  current.current = { historyTracks, onSelect, followKey, onFollow, onStopFollowing, onAirportSelect };
  const [error, setError] = useState(false);

  useEffect(() => {
    let baseMap = 'satellite';
    try { if (localStorage.getItem(storageKey) === 'dark') baseMap = 'dark'; } catch { /* Storage is optional. */ }
    let map;
    try {
      map = new GLMap({ container: element.current, style: baseMap === 'dark' ? darkStyle : satelliteStyle,
        center: [110, 25], zoom: 2, maxZoom: 19, maxPitch: 0, dragRotate: false, touchPitch: false });
    } catch {
      setError(true);
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left');
    const select = document.createElement('select');
    select.className = 'maplibregl-ctrl basemap-select';
    select.setAttribute('aria-label', '地图底图');
    select.add(new Option('卫星底图', 'satellite'));
    select.add(new Option('深色底图', 'dark'));
    select.value = baseMap;
    const popup = new Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 14 });
    select.onchange = () => {
      baseMap = select.value;
      try { localStorage.setItem(storageKey, baseMap); } catch { /* Storage is optional. */ }
      popup.remove();
      map.setStyle(baseMap === 'dark' ? darkStyle : satelliteStyle, { diff: false });
    };
    map.addControl({ onAdd: () => select, onRemove: () => select.remove() }, 'bottom-left');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    const sources = Object.fromEntries(['planes', 'history', 'track', 'receiver', 'last-known', 'airports', 'route-airports', 'airport-runways'].map((id) => [id, collection()]));
    const icon = aircraftImage();
    const tower = towerImage();
    const airportByKey = new Map();
    map.on('style.load', () => addRadarLayers(map, sources, icon, tower));
    function update(id, data) {
      sources[id] = data;
      map.getSource(id)?.setData(data);
    }

    const planes = new Map(), moving = new Set();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frameID = null;
    let lastFrame = -Infinity;
    function animate(now) {
      frameID = null;
      // One GeoJSON update per frame for the entire fleet, capped to about 30 fps.
      if (now - lastFrame >= 30) {
        lastFrame = now;
        for (const entry of moving) {
          const { from, to, start, duration } = entry.motion;
          const progress = reducedMotion.matches ? 1 : (now - start) / duration;
          const [lat, lng] = interpolatePosition(from, to, progress);
          entry.coord = [lng, lat];
          if (progress >= 1) moving.delete(entry);
        }
        update('planes', collection([...planes].map(([key, { coord, point, selected }]) => feature('Point', coord, {
          key, selected: +selected, label: point.flight || point.hex, heading: point.track ?? 0, color: pointColor(point),
        }))));
        const followed = planes.get(current.current.followKey);
        if (followed && !map.isMoving()) {
          const center = map.getCenter();
          const [lng, lat] = followed.coord;
          const longitude = nearestLongitude(center.lng, lng);
          if (Math.abs(center.lng - longitude) > 1e-7 || Math.abs(center.lat - lat) > 1e-7) map.setCenter([longitude, lat]);
        }
      } else {
        frameID = requestAnimationFrame(animate);
      }
      if (moving.size && frameID === null) frameID = requestAnimationFrame(animate);
    }
    function redraw() {
      if (frameID === null) frameID = requestAnimationFrame(animate);
    }

    map.on('mousemove', ({ point }) => {
      const hit = map.getLayer('planes') && map.queryRenderedFeatures(point, { layers: hoverLayers })[0];
      map.getCanvas().style.cursor = hit && (hit.layer.id === 'planes' || airportLayers.includes(hit.layer.id)) ? 'pointer' : '';
      if (!hit?.properties.label) return popup.remove();
      const [lng, lat] = hit.geometry.coordinates;
      popup.setLngLat([nearestLongitude(map.unproject(point).lng, lng), lat]).setText(hit.properties.label);
      if (!popup.isOpen()) popup.addTo(map);
    });
    map.getCanvas().addEventListener('mouseleave', () => popup.remove());
    const hitBox = ({ x, y }) => [[x - 9, y - 9], [x + 9, y + 9]];
    map.on('click', ({ point }) => {
      if (!map.getLayer('planes')) return;
      const hits = map.queryRenderedFeatures(hitBox(point), { layers: pickLayers });
      const plane = hits.find(({ layer }) => layer.id === 'planes');
      const position = plane && planes.get(plane.properties.key)?.point;
      if (position) return current.current.onSelect?.(position);
      const airportHit = hits.find(({ layer }) => airportLayers.includes(layer.id));
      const airport = airportByKey.get(airportHit?.properties.airportKey);
      if (airport) return current.current.onAirportSelect?.(airport);
      const sample = nearestSample(map, point, current.current.historyTracks, hits.filter(({ layer }) => layer.id.startsWith('history-')));
      if (sample) current.current.onSelect?.(sample, true);
    });
    map.on('dblclick', (event) => {
      if (!map.getLayer('planes')) return;
      const hit = map.queryRenderedFeatures(hitBox(event.point), { layers: ['planes'] })[0];
      const plane = hit && planes.get(hit.properties.key)?.point;
      if (!plane) return;
      event.preventDefault();
      current.current.onFollow(plane);
    });
    map.on('dragstart', () => current.current.onStopFollowing());
    map.on('moveend', () => { if (current.current.followKey) redraw(); });
    radar.current = { map, update, planes, moving, redraw, reducedMotion, airportByKey, centered: false };
    return () => {
      radar.current = null;
      if (frameID !== null) cancelAnimationFrame(frameID);
      popup.remove();
      map.remove();
    };
  }, []);

  const stationID = station?.id;
  const lat = station?.samples.receiver?.lat, lon = station?.samples.receiver?.lon;
  useEffect(() => {
    const r = radar.current;
    if (!r) return;
    r.centered = Number.isFinite(lat) && Number.isFinite(lon);
    r.update('receiver', r.centered ? receiverData(lon, lat) : collection());
    if (r.centered) r.map.jumpTo({ center: [lon, lat], zoom: 7 });
  }, [stationID, lat, lon]);

  useEffect(() => {
    const r = radar.current;
    if (!r) return;
    const { planes, moving, map, reducedMotion, redraw } = r;
    const visible = new Set();
    let changed = false;
    for (const point of points) {
      const key = `${point.receiver_id}/${point.hex}`, selected = point.hex === selectedHex;
      visible.add(key);
      const entry = planes.get(key);
      if (!entry) {
        planes.set(key, { point, selected, coord: position(point) });
        changed = true;
        continue;
      }
      if (entry.point === point && entry.selected === selected) continue;
      changed = true;
      if (point.lat !== entry.point.lat || point.lon !== entry.point.lon) {
        const [lng, lat] = entry.coord;
        const to = { lng: nearestLongitude(lng, point.lon), lat: point.lat };
        const gap = Date.parse(point.position_at) - Date.parse(entry.point.position_at);
        const duration = reducedMotion.matches ? 0 : motionDuration(gap, new LngLat(lng, lat).distanceTo(to));
        if (duration) {
          entry.motion = { from: { lng, lat }, to, start: performance.now(), duration };
          moving.add(entry);
        } else {
          moving.delete(entry);
          entry.coord = [to.lng, to.lat];
        }
      }
      entry.point = point;
      entry.selected = selected;
    }
    for (const [key, entry] of planes) if (!visible.has(key)) {
      moving.delete(entry);
      planes.delete(key);
      changed = true;
    }
    if (changed) redraw();
    if (!r.centered && points.length) {
      const bounds = new LngLatBounds();
      for (const p of points) bounds.extend([nearestLongitude(points[0].lon, p.lon), p.lat]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 7, duration: 0 });
      r.centered = true;
    }
  }, [points, selectedHex, stationID, lat, lon]);

  useEffect(() => { radar.current?.update('track', trailData([{ segments: [track] }])); }, [track]);
  useEffect(() => { radar.current?.update('history', trailData(historyTracks)); }, [historyTracks]);
  useEffect(() => {
    const ranges = new Map(parseMETAR(airportMETAR?.rawOb).rvr.map((range) => [range.runway, formatRVR(range)]));
    const labels = (airportRunways ?? []).flatMap(({ start, end, low, high, closed }) => {
      const points = [];
      for (const [coordinates, label] of [[start, low], [end, high]]) {
        if (!coordinates || !label) continue;
        const rvr = ranges.get(label.toUpperCase().padStart(/^[0-9][LCR]$/i.test(label) ? 3 : 2, '0'));
        points.push(feature('Point', coordinates, { label, closed, ...(rvr && { rvr: `RVR ${rvr}` }) }));
      }
      return points;
    });
    radar.current?.update('airport-runways', collection(labels));
  }, [airportRunways, airportMETAR]);
  useEffect(() => {
    const r = radar.current;
    if (!r) return;
    const byICAO = new Map(airports.filter((airport) => airport.icao).map((airport) => [airport.icao, airport]));
    const route = referenceRoute?.airports ?? [];
    const routeCodes = new Set(route.map((airport) => airport.icao));
    r.airportByKey.clear();
    function marker(airport, airportKey) {
      const code = airportCode(airport);
      r.airportByKey.set(airportKey, airport);
      return feature('Point', position(airport), { airportKey, kind: airport.type || '', code, label: `${code} · ${airport.name || code}` });
    }
    r.update('airports', collection(airports.filter((airport) => !routeCodes.has(airport.icao))
      .map((airport) => marker(airport, airport.id))));
    r.update('route-airports', collection(route.map((airport) => marker(byICAO.get(airport.icao) ?? airport, `route/${airport.icao}`))));
  }, [referenceRoute, airports]);
  useEffect(() => {
    radar.current?.update('last-known', collection(lastKnown ? [feature('Point', position(lastKnown), {
      label: lastKnown.historical ? '历史采样点' : '最后位置',
    })] : []));
  }, [lastKnown]);
  useEffect(() => {
    const map = radar.current?.map;
    if (!map || !pan) return;
    if (pan.zoom != null) map.easeTo({ center: position(pan), zoom: Math.max(map.getZoom(), pan.zoom) });
    else map.panTo(position(pan));
  }, [pan]);
  useEffect(() => { if (followKey) radar.current?.redraw(); }, [followKey]);
  useEffect(() => {
    if (radar.current) return animateAirportWind(radar.current.map, windCanvas.current, selectedAirport, airportMETAR, airportRunways);
  }, [selectedAirport, airportMETAR, airportRunways]);

  return <div className="map" aria-label="实时空域地图">
    <div className="map-canvas" ref={element} />
    <canvas className="airport-wind" ref={windCanvas} aria-hidden="true" />
    {error && <p className="map-error" role="status">无法显示地图：请检查浏览器是否支持 WebGL 2。</p>}
  </div>;
}
