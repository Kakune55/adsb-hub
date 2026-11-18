import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapView from './MapView.jsx';
import AircraftSearch from './AircraftSearch.jsx';
import TrailControl from './TrailControl.jsx';
import { altitudeGradient } from './altitude.js';
import './style.css';

const emptyPoints = [];
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const measure = (value, unit = '') => value == null ? '—' : `${number.format(value)}${unit ? ` ${unit}` : ''}`;
const timeLabel = (time) => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';

function usePoll(path, interval, recentTrack = false) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const now = Date.now();
        const range = recentTrack ? `&${new URLSearchParams({
          from: new Date(now - 30 * 60000).toISOString(), to: new Date(now + 1000).toISOString(),
        })}` : '';
        const response = await fetch(`/api/v1/${path}${range}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!controller.signal.aborted) setResult({ path, data, receivedAt: now });
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult((prev) => ({ ...(prev?.path === path ? prev : {}), path, error: error.message }));
        }
      } finally {
        if (interval && !controller.signal.aborted) timer = setTimeout(refresh, interval);
      }
    }
    refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, interval, recentTrack]);
  return path && result?.path === path ? result : null;
}

function App() {
  const [stationID, setStationID] = useState('');
  const [selection, setSelection] = useState(null);
  const [pan, setPan] = useState(null);
  const [range, setRange] = useState(null);
  const [clock, setClock] = useState(Date.now);
  const receivers = usePoll('receivers', 10000);
  const stations = receivers?.data ?? [];
  const station = stations.find(({ id }) => id === stationID) ?? stations[0];
  const live = usePoll(station ? `live?${new URLSearchParams({ receiver_id: station.id })}` : null, 2000);
  const serverNow = live?.data && Date.parse(live.data.server_time) + Math.max(0, clock - live.receivedAt);
  const points = live?.data?.points.filter((p) => Date.parse(p.position_at) > serverNow - live.data.max_age_seconds * 1000) ?? emptyPoints;
  const selectedPoint = selection?.historical ? null : points.find(({ hex }) => hex === selection?.hex);
  const history = usePoll(station && range ? `trails?${new URLSearchParams({ receiver_id: station.id, from: range.from, to: range.to })}` : null, 0);
  const focused = selectedPoint ?? selection;
  const trackParams = station && selection && !selection.historical && { receiver_id: station.id, hex: selection.hex };
  const track = usePoll(trackParams ? `track?${new URLSearchParams(trackParams)}` : null, 4000, true);
  const trail = track?.data?.points ?? emptyPoints;
  const displayTrail = selectedPoint && (!trail.length || Date.parse(selectedPoint.position_at) > Date.parse(trail.at(-1).position_at))
    ? [...trail, selectedPoint] : trail;

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (selectedPoint) setSelection(selectedPoint);
  }, [selectedPoint]);

  function select(point, reposition, historical = false) {
    setSelection(historical ? { ...point, historical } : point);
    if (reposition) setPan({ lat: point.lat, lon: point.lon });
  }

  return <main className="radar">
    <MapView station={station} points={points} track={displayTrail} selectedHex={selection?.hex} lastKnown={selectedPoint ? null : selection}
      pan={pan} historyTracks={history?.data?.routes ?? emptyPoints} onSelect={(point, historical) => select(point, false, historical)} />
    <div className="radar-brand"><span className="brand-icon" aria-hidden="true" />ADS-B <b>Hub</b></div>
    <AircraftSearch stationID={station?.id} onPick={(match) => select(points.find(({ hex }) => hex === match.hex) ?? match, true)} />
    <TrailControl range={range} onRange={setRange} history={history} ready={Boolean(station)} />
    <div className="altitude-legend" aria-label="气压高度色标，单位英尺">
      <span>高度 · ft</span><div style={{ background: altitudeGradient }} className="altitude-scale" />
      <div className="altitude-ticks"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>40k+</span></div>
    </div>
    <aside className="focus-panel" aria-label="飞机详情">
      <AircraftDetails point={focused} onClose={selection ? () => setSelection(null) : null} />
      {track?.error && <p className="notice" role="status">航迹获取失败</p>}
    </aside>
    <aside className="radar-panel" aria-label="雷达站与附近飞机">
      <section className="station-panel">
        <div className="station-heading">
          <select aria-label="雷达站" value={station?.id ?? ''} onChange={(e) => {
            setStationID(e.target.value); setSelection(null); setPan(null);
          }}>
            {stations.length ? stations.map(({ id, name }) => <option key={id} value={id}>{name}</option>) : <option value="">雷达站</option>}
          </select>
          <span className={`pill ${station?.fresh && !receivers?.error ? 'good' : ''}`}><i />{receivers?.error ? '异常' : station?.fresh ? '在线' : '暂无上报'}</span>
        </div>
        <dl className="metrics">
          <div><dt>最近上报</dt><dd>{timeLabel(station?.last_sample_at)}</dd></div>
          <div><dt>报文 / 秒</dt><dd>{measure(station?.samples.stats?.messages_per_second)}</dd></div>
          <div><dt>增益</dt><dd>{measure(station?.samples.stats?.gain_db, 'dB')}</dd></div>
          <div><dt>经纬度</dt><dd>{station?.samples.receiver?.lat != null && station.samples.receiver.lon != null
            ? `${station.samples.receiver.lat.toFixed(4)}, ${station.samples.receiver.lon.toFixed(4)}` : '—'}</dd></div>
        </dl>
      </section>
      <section className="traffic-panel" aria-label="附近飞机">
        <div className="traffic-heading"><h2>附近飞机 <span>{points.length}</span></h2>{live?.error && <small>更新失败</small>}</div>
        <div className="aircraft-table">
          <table aria-label="附近飞机">
            <thead><tr><th scope="col">呼号 / HEX</th><th scope="col">高度 <small>ft</small></th><th scope="col">地速 <small>kt</small></th><th scope="col">航迹角 <small>°</small></th></tr></thead>
            <tbody>{points.map((point) => <tr key={point.hex} className={point.hex === selection?.hex ? 'chosen' : ''} onClick={() => select(point, true)}>
              <td><button type="button" aria-pressed={point.hex === selection?.hex}>{point.flight || point.hex}</button>{point.flight && <small>{point.hex}</small>}</td>
              <td>{point.on_ground ? '地面' : measure(point.alt_baro)}</td><td>{measure(point.gs)}</td><td>{measure(point.track)}</td>
            </tr>)}</tbody>
          </table>
          {!points.length && <p className="notice">暂无飞机</p>}
        </div>
      </section>
    </aside>
  </main>;
}

function AircraftDetails({ point, onClose }) {
  return <section className="aircraft-details">
    <header><h1>{point?.flight || point?.hex || '飞机详情'}</h1>
      {onClose && <button className="close" onClick={onClose} aria-label="清除选中飞机">×</button>}
    </header>
    {point && <dl className="metrics">
      <div><dt>HEX</dt><dd>{point.hex}</dd></div>
      <div><dt>气压高度</dt><dd>{point.on_ground ? '地面' : measure(point.alt_baro, 'ft')}</dd></div>
      <div><dt>地速</dt><dd>{measure(point.gs, 'kt')}</dd></div>
      <div><dt>航迹角</dt><dd>{measure(point.track, '°')}</dd></div>
      <div><dt>纬度</dt><dd>{point.lat.toFixed(5)}</dd></div>
      <div><dt>经度</dt><dd>{point.lon.toFixed(5)}</dd></div>
      <div className="wide"><dt>{point.historical ? '历史采样时间' : '最后位置时间'}</dt><dd>{timeLabel(point.position_at)}{point.position_at_approximate && ' · 近似'}</dd></div>
    </dl>}
  </section>;
}

createRoot(document.getElementById('root')).render(<App />);
