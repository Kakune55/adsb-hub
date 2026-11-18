import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { altitudeColor } from './altitude.js';

function planeIcon(point, selected) {
  const heading = Number.isFinite(point.track) ? point.track : 0;
  return L.divIcon({
    className: `plane-icon${selected ? ' plane-selected' : ''}`,
    iconSize: [30, 30],
    html: `<svg aria-hidden="true" viewBox="0 0 28 28" style="transform: rotate(${heading}deg)" fill="${altitudeColor(point.on_ground ? 0 : point.alt_baro)}"><path d="M14 2c1 0 2 1.7 2 4v5l9 6v2l-9-3v5l4 3v2l-6-2-6 2v-2l4-3v-5l-9 3v-2l9-6V6c0-2.3 1-4 2-4Z"/></svg>`,
  });
}

function drawTrails(layer, renderer, segments, focused = false) {
  layer.clearLayers();
  const lines = new Map();
  const dots = [];
  for (const points of segments) {
    let previous, active, lastColor;
    for (const point of points) {
      const coord = [point.lat, point.lon];
      dots.push(coord);
      const color = altitudeColor(point.on_ground ? 0 : point.alt_baro);
      if (previous) {
        if (color !== lastColor || !active) {
          if (!lines.has(color)) lines.set(color, []);
          active = [previous];
          lines.get(color).push(active);
        }
        active.push(coord);
      }
      previous = coord;
      lastColor = color;
    }
  }
  for (const [color, paths] of lines) {
    L.polyline(paths, { color, weight: focused ? 3 : 2, opacity: focused ? .95 : .66, renderer, interactive: false }).addTo(layer);
  }
  for (const dot of dots) {
    L.circleMarker(dot, { radius: focused ? 1.7 : 1.3, stroke: false, fillColor: '#fff', fillOpacity: focused ? .62 : .42, renderer, interactive: false }).addTo(layer);
  }
}

export function nearestSample(map, cursor, tracks) {
  let best = null;
  let distance = 9;
  for (const { hex, segments } of tracks) {
    for (const samples of segments) {
      let previous, previousDistance;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const point = map.latLngToContainerPoint([sample.lat, sample.lon]);
        const pointDistance = cursor.distanceTo(point);
        const hit = previous ? L.LineUtil.pointToSegmentDistance(cursor, previous, point) : pointDistance;
        if (hit < distance) {
          distance = hit;
          best = { ...(previous && previousDistance <= pointDistance ? samples[i - 1] : sample), hex };
        }
        previous = point;
        previousDistance = pointDistance;
      }
    }
  }
  return best;
}

export default function MapView({ station, points, track, selectedHex, lastKnown, pan, historyTracks, onSelect }) {
  const element = useRef(null);
  const layers = useRef(null);
  const selection = useRef(onSelect);
  selection.current = onSelect;

  useEffect(() => {
    const map = L.map(element.current, { worldCopyJump: true, zoomControl: false }).setView([25, 110], 3);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri World Imagery</a> · Esri, Vantor, Earthstar Geographics, GIS User Community',
    }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    const historyPane = map.createPane('history');
    historyPane.style.zIndex = '390';
    historyPane.style.pointerEvents = 'none';
    layers.current = {
      map, planes: new Map(), receiver: L.layerGroup().addTo(map),
      trail: L.layerGroup().addTo(map), lastKnown: L.layerGroup().addTo(map), history: L.layerGroup().addTo(map),
      historyRenderer: L.canvas({ pane: 'history' }), focusRenderer: L.canvas(), hasCenter: false,
    };
    return () => map.remove();
  }, []);

  const stationID = station?.id;
  const lat = station?.samples.receiver?.lat;
  const lon = station?.samples.receiver?.lon;
  const hasReceiver = Number.isFinite(lat) && Number.isFinite(lon);

  useEffect(() => {
    const { map, receiver } = layers.current;
    receiver.clearLayers();
    layers.current.hasCenter = false;
    if (hasReceiver) {
      for (const radius of [50000, 100000, 200000]) {
        L.circle([lat, lon], { radius, color: '#76bdfa', opacity: .32, weight: 1, dashArray: '4 7', fill: false, interactive: false }).addTo(receiver);
      }
      L.circleMarker([lat, lon], { radius: 5, color: '#cce7ff', fillColor: '#509ce8', fillOpacity: 1, weight: 2 })
        .bindTooltip('接收基站').addTo(receiver);
      map.setView([lat, lon], 8);
      layers.current.hasCenter = true;
    }
  }, [stationID, hasReceiver, lat, lon]);

  useEffect(() => {
    const { map, planes } = layers.current;
    const visible = new Set();
    for (const point of points) {
      const key = `${point.receiver_id}/${point.hex}`;
      visible.add(key);
      const label = point.flight || point.hex;
      const selected = point.hex === selectedHex;
      let entry = planes.get(key);
      if (!entry) {
        const marker = L.marker([point.lat, point.lon], { icon: planeIcon(point, selected), autoPanOnFocus: false }).addTo(map);
        entry = { point, selected, marker, label: document.createElement('span') };
        marker.bindTooltip(entry.label, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => selection.current?.(entry.point));
        planes.set(key, entry);
      } else {
        entry.marker.setLatLng([point.lat, point.lon]);
        if (selected !== entry.selected || point.track !== entry.point.track || point.on_ground !== entry.point.on_ground || point.alt_baro !== entry.point.alt_baro) {
          entry.marker.setIcon(planeIcon(point, selected));
        }
        entry.point = point;
        entry.selected = selected;
      }
      entry.label.textContent = label;
      entry.marker.setZIndexOffset(selected ? 1000 : 0);
      entry.marker.getElement().setAttribute('aria-label', `聚焦 ${label}`);
    }
    for (const [key, entry] of planes) {
      if (!visible.has(key)) {
        map.removeLayer(entry.marker);
        planes.delete(key);
      }
    }
    if (!layers.current.hasCenter && points.length) {
      map.fitBounds(points.map(({ lat, lon }) => [lat, lon]), { padding: [48, 48], maxZoom: 8 });
      layers.current.hasCenter = true;
    }
  }, [points, selectedHex, stationID, hasReceiver, lat, lon]);

  useEffect(() => {
    const { trail, focusRenderer } = layers.current;
    drawTrails(trail, focusRenderer, [track], true);
  }, [track]);

  useEffect(() => {
    const { map, history, historyRenderer } = layers.current;
    drawTrails(history, historyRenderer, historyTracks.flatMap(({ segments }) => segments));
    if (!historyTracks.length) return;
    function pick(e) {
      const sample = nearestSample(map, e.containerPoint, historyTracks);
      if (sample) selection.current?.(sample, true);
    }
    map.on('click', pick);
    return () => map.off('click', pick);
  }, [historyTracks]);

  useEffect(() => {
    const layer = layers.current.lastKnown;
    layer.clearLayers();
    if (lastKnown) {
      L.circleMarker([lastKnown.lat, lastKnown.lon], { radius: 7, color: '#ffc875', fillColor: '#182638', fillOpacity: .9 })
        .bindTooltip(lastKnown.historical ? '历史采样点' : '最后位置').addTo(layer);
    }
  }, [lastKnown]);

  useEffect(() => {
    if (pan) layers.current.map.panTo([pan.lat, pan.lon]);
  }, [pan]);

  return <div className="map" ref={element} aria-label="实时空域地图" />;
}
