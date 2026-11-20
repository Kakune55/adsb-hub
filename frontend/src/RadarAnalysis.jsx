import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { altitudeColor } from './altitude.js';
import { coverageDots, radarOffset } from './radarAnalysis.js';

const stamp = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });

export function ReplayControl({ replay, onTime, onStop }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const { from, to, at } = replay;
  useEffect(() => {
    if (!playing || at >= to) return;
    const started = performance.now();
    const timer = setTimeout(() => onTime((time) => Math.min(to, time + (performance.now() - started) * speed)), 100);
    return () => clearTimeout(timer);
  }, [playing, at, to, speed, onTime]);
  return <section className="replay-control" aria-label="航迹回放">
    <strong>{replay.mode === 'single' ? '单机回放' : '全站回放'}</strong><time>{stamp(at)}</time>
    <input type="range" min={from} max={to} step="any" value={at} aria-label="回放时间" onChange={(e) => { setPlaying(false); onTime(Number(e.target.value)); }} />
    <div className="analysis-actions">
      <button className="primary" type="button" onClick={() => { if (at >= to) { onTime(from); setPlaying(true); } else setPlaying(!playing); }}>{playing && at < to ? '暂停' : '播放'}</button>
      <select aria-label="回放倍速" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 5, 10, 30, 60].map((n) => <option key={n} value={n}>{n}×</option>)}</select>
      <button className="analysis-button" type="button" onClick={onStop}>返回实时</button>
    </div>
  </section>;
}

export function FlightCurves({ points, onSample }) {
  const [metric, setMetric] = useState('alt');
  const [index, setIndex] = useState(null);
  const metrics = { alt: ['高度', 'ft', (p) => p.on_ground ? 0 : p.alt_baro], speed: ['地速', 'kt', (p) => p.gs], climb: ['垂直速度', 'ft/min', (p) => p.telemetry?.baro_rate ?? p.baro_rate] };
  const [, unit, value] = metrics[metric];
  const series = useMemo(() => points.map((point) => ({ point, at: Date.parse(point.position_at) })), [points]);
  const samples = series.filter(({ point }) => Number.isFinite(value(point)));
  const low = samples.reduce((min, { point }) => Math.min(min, value(point)), Infinity);
  const high = samples.reduce((max, { point }) => Math.max(max, value(point)), -Infinity);
  const start = series[0]?.at, end = series.at(-1)?.at;
  const x = (at) => 8 + 224 * (at - start) / Math.max(1, end - start);
  const y = (point) => high === low ? 42 : 74 - 62 * (value(point) - low) / (high - low);
  let path = '', gaps = '', previous, interrupted = false;
  const coordinate = (sample) => `${x(sample.at).toFixed(1)},${y(sample.point).toFixed(1)}`;
  for (const sample of series) {
    if (!Number.isFinite(value(sample.point))) { interrupted = true; continue; }
    const connected = previous && !interrupted && sample.at - previous.at <= 30000;
    const end = coordinate(sample);
    path += `${connected ? 'L' : 'M'}${end} `;
    if (previous && !connected) gaps += `M${coordinate(previous)} L${end} `;
    previous = sample;
    interrupted = false;
  }
  const active = samples[index ?? -1];
  function pick(i) { setIndex(i); onSample(samples[i].point); }
  return <section className="detail-section flight-curves" aria-label="飞行曲线">
    <h2>飞行曲线</h2>
    <div className="analysis-actions">{Object.entries(metrics).map(([key, [label]]) => <button type="button" className="analysis-button" aria-pressed={metric === key} key={key} onClick={() => { setMetric(key); setIndex(null); onSample(null); }}>{label}</button>)}</div>
    {samples.length ? <>
      <svg viewBox="0 0 240 86" role="img" aria-label={`${metrics[metric][0]}时间曲线`} onPointerLeave={() => { setIndex(null); onSample(null); }} onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const target = (event.clientX - box.left) / box.width * 240;
        let lo = 0, hi = samples.length - 1;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (x(samples[mid].at) < target) lo = mid + 1; else hi = mid; }
        pick(lo > 0 && Math.abs(x(samples[lo - 1].at) - target) < Math.abs(x(samples[lo].at) - target) ? lo - 1 : lo);
      }}>
        <path d="M8 12V74H232 M8 43H232" className="analysis-grid" />
        {gaps && <path d={gaps} className="curve-line curve-gap" />}
        <path d={path} className="curve-line" />
        {active && <><path d={`M${x(active.at)} 12V74`} className="analysis-grid" /><circle cx={x(active.at)} cy={y(active.point)} r="3" fill="currentColor" /></>}
        {samples.length === 1 && !active && <circle cx={x(samples[0].at)} cy={y(samples[0].point)} r="3" fill="currentColor" />}
      </svg>
      <input type="range" min="0" max={samples.length - 1} value={index != null && active ? index : 0} aria-label="曲线采样点" onChange={(e) => pick(Number(e.target.value))} />
      <p className="analysis-caption">{active ? `${stamp(active.at)} · ${value(active.point)} ${unit}` : `${low}–${high} ${unit}`}</p>
    </> : <p className="analysis-caption">无此项采样</p>}
  </section>;
}

const radarRadius = 131;

export const CoverageScatter = memo(function CoverageScatter({ routes, lat, lon, duration }) {
  const canvas = useRef(null);
  const data = useMemo(() => coverageDots(routes, { lat, lon }, duration, radarRadius), [routes, lat, lon, duration]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const { dots, max } = data;
    const center = 160, radius = radarRadius;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, 320, 320);
    ctx.translate(center, center);
    ctx.strokeStyle = '#505056';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#b3b3b7';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.moveTo(-radius, 0); ctx.lineTo(radius, 0);
    ctx.moveTo(0, -radius); ctx.lineTo(0, radius);
    for (let ring = 1; ring <= 4; ring++) {
      const r = radius * ring / 4;
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.78;
    for (const { x, y, altitude } of dots) {
      ctx.fillStyle = altitudeColor(altitude);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e0e0e0';
    for (const [label, bearing] of [['北', 0], ['东', 90], ['南', 180], ['西', 270]]) {
      ctx.fillText(label, ...radarOffset(bearing, radius + 15));
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#252526';
    ctx.fillStyle = '#b3b3b7';
    for (let ring = 1; ring <= 4; ring++) {
      const label = `${max * ring / 4} km`;
      const [x, y] = radarOffset(45, radius * ring / 4);
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
    }
    ctx.fillRect(-1.5, -1.5, 3, 3);
  }, [data]);
  return <section className="detail-section coverage-scatter" aria-label="接收覆盖散点图"><h2>接收覆盖散点图</h2>
    {data.dots.length ? <><canvas ref={canvas} width="640" height="640" role="img" aria-label="北向朝上的接收覆盖雷达散点图" />
      <p className="analysis-caption">{data.dots.length.toLocaleString()} / {data.count.toLocaleString()} 点 · {data.merged ? '像素格合并' : '全量'} · 按高度着色</p></> : <p className="analysis-caption">没有可用采样或接收站坐标</p>}
  </section>;
});
