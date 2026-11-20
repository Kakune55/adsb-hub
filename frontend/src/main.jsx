import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CoverageScatter, FlightCurves, ReplayControl } from './RadarAnalysis.jsx';
import { inViewport, replayPositions, samplesForReplay, stationObservation } from './radarAnalysis.js';
import { createRoot } from 'react-dom/client';
import MapView from './MapView.jsx';
import AircraftSearch from './AircraftSearch.jsx';
import AircraftPhoto from './AircraftPhoto.jsx';
import { formatRVR, parseMETAR } from './metar.js';
import ReferenceRoute, { useReferenceRoute } from './ReferenceRoute.jsx';
import TrailControl from './TrailControl.jsx';
import { altitudeColor, altitudeGradient } from './altitude.js';
import './style.css';

const emptyPoints = [];
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const measure = (value, unit = '') => value == null ? '—' : `${number.format(value)}${unit ? ` ${unit}` : ''}`;
const timeLabel = (time) => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';

function stationDistance(point, receiver) {
  if (!point || !Number.isFinite(receiver?.lat) || !Number.isFinite(receiver?.lon)) return null;
  const rad = Math.PI / 180;
  const a = Math.sin((point.lat - receiver.lat) * rad / 2) ** 2 +
    Math.cos(point.lat * rad) * Math.cos(receiver.lat * rad) * Math.sin((point.lon - receiver.lon) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

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

function useLiveStream(stationID) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!stationID) return;
    setResult(null);
    let source, retry;
    function applySnapshot({ data }) {
      setResult({ stationID, data: JSON.parse(data), receivedAt: Date.now() });
    }
    function applyPositions({ data }) {
      const update = JSON.parse(data);
      const receivedAt = Date.now();
      const cutoff = Date.parse(update.server_time) - update.max_age_seconds * 1000;
      setResult((prev) => {
        if (prev?.stationID !== stationID || !prev.data) return prev;
        const latest = new Map();
        for (const point of prev.data.points) {
          if (Date.parse(point.position_at) > cutoff) latest.set(point.hex, point);
        }
        for (const point of update.points) latest.set(point.hex, point);
        const points = [...latest.values()].sort((a, b) => a.hex.localeCompare(b.hex));
        return { stationID, data: { ...update, points }, receivedAt };
      });
    }
    function connect() {
      source = new EventSource(`/api/v1/live/stream?${new URLSearchParams({ receiver_id: stationID })}`);
      source.addEventListener('snapshot', applySnapshot);
      source.addEventListener('positions', applyPositions);
      source.onerror = () => {
        setResult((prev) => ({ ...(prev?.stationID === stationID ? prev : {}), stationID, error: true }));
        // HTTP errors can close EventSource permanently instead of triggering its native retry.
        if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => { clearTimeout(retry); source.close(); };
  }, [stationID]);
  return stationID && result?.stationID === stationID ? result : null;
}

function App() {
  const [stationID, setStationID] = useState('');
  const [selection, setSelection] = useState(null);
  const [selectedAirport, setSelectedAirport] = useState(null);
  const detailsID = selectedAirport?.id || selectedAirport?.icao;
  const airportDetails = usePoll(detailsID ? `airports/details?${new URLSearchParams({ id: detailsID })}` : null, 0)?.data;
  const airportICAO = selectedAirport?.icao;
  const weatherPath = (kind) => /^[A-Z]{4}$/.test(airportICAO ?? '') ? `airports/weather?${new URLSearchParams({ icao: airportICAO, kind })}` : null;
  const metar = usePoll(weatherPath('metar'), 300000)?.data;
  const taf = usePoll(weatherPath('taf'), 300000)?.data;
  const [followKey, setFollowKey] = useState(null);
  const [pan, setPan] = useState(null);
  const [range, setRange] = useState(null);
  const [replay, setReplay] = useState(null);
  const [replayAt, setReplayAt] = useState(0);
  const [coverage, setCoverage] = useState(false);
  const [viewport, setViewport] = useState(null);
  const [filter, setFilter] = useState({ viewport: false, ground: true, min: '', max: '' });
  const [chartPoint, setChartPoint] = useState(null);
  const [clock, setClock] = useState(Date.now);
  const weatherAge = clock - Date.parse(metar?.reportTime);
  const mapMETAR = weatherAge >= -300000 && weatherAge <= 7200000 ? metar : null;
  const receivers = usePoll('receivers', 10000);
  const airports = usePoll('airports', 0)?.data ?? emptyPoints;
  const stations = receivers?.data ?? [];
  const station = stations.find(({ id }) => id === stationID) ?? stations[0];
  const live = useLiveStream(station?.id);
  const serverNow = live?.data && Date.parse(live.data.server_time) + Math.max(0, clock - live.receivedAt);
  const points = live?.data?.points.filter((p) => Date.parse(p.position_at) > serverNow - live.data.max_age_seconds * 1000) ?? emptyPoints;
  const selectedPoint = replay || selection?.historical ? null : points.find(({ hex }) => hex === selection?.hex);
  const history = usePoll(station && range ? `trails?${new URLSearchParams({ receiver_id: station.id, from: range.from, to: range.to })}` : null, 0);
  const routes = history?.data?.routes ?? emptyPoints;
  const replaying = replay && replay.receiverID === station?.id ? replay : null;
  const replayPoints = useMemo(() => replaying ? replayPositions(replaying.routes, replayAt, replaying.receiverID) : emptyPoints, [replaying, replayAt]);
  const mapPoints = (replaying ? replayPoints : points).filter((p) => {
    const alt = p.on_ground ? 0 : p.alt_baro;
    return (!filter.viewport || inViewport(p, viewport)) && (filter.ground || !p.on_ground) &&
      (filter.min === '' || (alt != null && alt >= Number(filter.min))) &&
      (filter.max === '' || (alt != null && alt <= Number(filter.max)));
  });
  const focused = replaying ? replayPoints.find((p) => p.hex === selection?.hex) ?? null : selectedPoint ?? selection;
  const referenceRoute = useReferenceRoute(focused?.flight);
  const trackParams = !replaying && station && selection && !selection.historical && { receiver_id: station.id, hex: selection.hex };
  const track = usePoll(trackParams ? `track?${new URLSearchParams(trackParams)}` : null, 4000, true);
  const trail = track?.data?.points ?? emptyPoints;
  const displayTrail = selectedPoint && (!trail.length || Date.parse(selectedPoint.position_at) > Date.parse(trail.at(-1).position_at))
    ? [...trail, selectedPoint] : trail;
  const curvePoints = replaying ? replaying.routes.find(({ hex }) => hex === selection?.hex)?.curve ?? emptyPoints :
    selection?.historical ? routes.find(({ hex }) => hex === selection.hex)?.segments.flat() ?? emptyPoints : displayTrail;

  function startReplay(mode, source) {
    const indexed = samplesForReplay(source).map((route) => ({ ...route, curve: route.samples.map(({ point }) => point) }));
    if (!indexed.length) return;
    const from = indexed.reduce((min, { samples }) => Math.min(min, samples[0].at), Infinity);
    const to = indexed.reduce((max, { samples }) => Math.max(max, samples.at(-1).at), -Infinity);
    if (to <= from) return;
    setReplay({ mode, routes: indexed, from, to, receiverID: station.id });
    setReplayAt(from);
    setFollowKey(null); setSelectedAirport(null); setChartPoint(null);
    if (mode === 'station') setSelection(null);
  }

  function stopReplay() {
    setReplay(null); setSelection(null); setChartPoint(null);
  }

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (selectedPoint) setSelection(selectedPoint);
  }, [selectedPoint]);

  function select(point, reposition, historical = false) {
    setSelectedAirport(null);
    setChartPoint(null);
    const keepFollowing = !historical && followKey === `${point.receiver_id}/${point.hex}`;
    if (!keepFollowing) setFollowKey(null);
    setSelection(historical || replaying ? { ...point, historical: true } : point);
    if (reposition && !keepFollowing) setPan({ lat: point.lat, lon: point.lon });
  }

  function toggleFollow(point) {
    if (replaying) return;
    setSelectedAirport(null);
    const key = `${point.receiver_id}/${point.hex}`;
    setSelection(point);
    setFollowKey((current) => current === key ? null : key);
  }

  function selectAirport(airport, locate = false) {
    setSelectedAirport(airport);
    setChartPoint(null);
    setFollowKey(null);
    if (locate) setPan({ lat: airport.lat, lon: airport.lon });
  }

  return <main className="radar">
    <section className="map-workspace" aria-label="地图工作区">
      <MapView station={station} points={mapPoints} track={replaying ? emptyPoints : displayTrail} selectedHex={selection?.hex} lastKnown={replaying || selectedPoint ? null : selection}
      pan={pan} historyTracks={replaying ? emptyPoints : routes} onSelect={(point, historical) => select(point, false, historical)}
      followKey={followKey} onFollow={toggleFollow} onStopFollowing={() => setFollowKey(null)} referenceRoute={referenceRoute}
      airports={airports} onAirportSelect={selectAirport} airportRunways={airportDetails?.runways} selectedAirport={selectedAirport} airportMETAR={mapMETAR}
      onViewport={setViewport} chartPoint={chartPoint} replaying={Boolean(replaying)} />
      {replaying ? <ReplayControl replay={{ ...replaying, at: replayAt }} onTime={setReplayAt} onStop={stopReplay} /> :
        <AircraftSearch stationID={station?.id} onPick={(match) => select(points.find(({ hex }) => hex === match.hex) ?? match, true)} />}
      <div className="altitude-legend" aria-label="气压高度色标，单位英尺">
        <span>高度 · ft</span><div style={{ background: altitudeGradient }} className="altitude-scale" />
        <div className="altitude-ticks"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>40k+</span></div>
      </div>
    </section>
    <aside className="focus-panel" aria-label={selectedAirport ? '机场详情' : '飞机详情'}>
      <div className="radar-brand"><span className="brand-icon" aria-hidden="true" />ADS-B <b>Hub</b></div>
      {selectedAirport ? <AirportDetails airport={selectedAirport} receiver={station?.samples.receiver}
        activity={points} onSelectAircraft={(point) => { if (replaying) stopReplay(); select(point, true); }}
        details={airportDetails} metar={metar} taf={taf} onShowRunways={() => setPan({ lat: selectedAirport.lat, lon: selectedAirport.lon, zoom: 12 })}
        onClose={() => setSelectedAirport(null)} /> : <AircraftDetails point={focused} following={Boolean(followKey)} isLive={Boolean(selectedPoint)}
        receiver={station?.samples.receiver} serverNow={serverNow}
        referenceRoute={referenceRoute} onLocateAirport={(airport) => selectAirport(airports.find((a) => a.icao === airport.icao) ?? airport, true)}
        onFollow={replaying ? null : followKey ? () => setFollowKey(null) : selectedPoint ? () => toggleFollow(selectedPoint) : null}
        onClose={selection ? () => { setFollowKey(null); setSelection(null); setChartPoint(null); } : null} />}
      {!selectedAirport && selection && curvePoints.length > 0 && <>
        {!replaying && curvePoints.length > 1 && <button className="primary follow-button" type="button" onClick={() => startReplay('single', [{ hex: selection.hex, segments: [curvePoints] }])}>单机回放</button>}
        <FlightCurves key={`${selection.hex}/${replaying?.mode ?? 'live'}`} points={curvePoints} onSample={setChartPoint} />
      </>}
      {!selectedAirport && track?.error && <p className="notice" role="status">航迹获取失败</p>}
    </aside>
    <aside className="radar-panel" aria-label="雷达站与附近飞机">
      <section className="station-panel">
        <div className="station-heading">
          <select aria-label="雷达站" value={station?.id ?? ''} onChange={(e) => {
            setStationID(e.target.value); stopReplay(); setCoverage(false); setFollowKey(null); setSelectedAirport(null); setPan(null);
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
      <div className="traffic-workspace">
        <details className="radar-filters"><summary>筛选</summary><div className="filter-fields">
          <label><input type="checkbox" checked={filter.viewport} onChange={(e) => setFilter({ ...filter, viewport: e.target.checked })} />仅视野内</label>
          <label><input type="checkbox" checked={filter.ground} onChange={(e) => setFilter({ ...filter, ground: e.target.checked })} />显示地面目标</label>
          <label>最低高度 (ft)<input type="number" value={filter.min} onChange={(e) => setFilter({ ...filter, min: e.target.value })} /></label>
          <label>最高高度 (ft)<input type="number" value={filter.max} onChange={(e) => setFilter({ ...filter, max: e.target.value })} /></label>
        </div></details>
        {coverage ? <CoverageScatter routes={routes} lat={station?.samples.receiver?.lat} lon={station?.samples.receiver?.lon}
          duration={Date.parse(range?.to) - Date.parse(range?.from)} /> : <TrafficTable points={mapPoints} receiver={station?.samples.receiver} serverNow={replaying ? replayAt : serverNow} historical={Boolean(replaying)}
          selectedHex={selection?.hex} error={!replaying && live?.error} onSelect={(point) => select(point, true, Boolean(replaying))} />}
      </div>
      <TrailControl range={range} onRange={(next) => { if (replaying) stopReplay(); if (!next) setCoverage(false); setRange(next); }} history={history} ready={Boolean(station)}
        actions={<div className="analysis-actions">
          <button className="analysis-button" type="button" disabled={!history?.data?.first_position_at || history.data.first_position_at === history.data.last_position_at} onClick={() => { setCoverage(false); startReplay('station', routes); }}>全站回放</button>
          <button className="analysis-button" type="button" disabled={!station} aria-pressed={coverage} onClick={() => {
            if (replaying) stopReplay();
            if (!range) { const now = Date.now(); setRange({ minutes: 30, from: new Date(now - 1800000).toISOString(), to: new Date(now).toISOString() }); }
            setCoverage(!coverage);
          }}>覆盖散点图</button>
        </div>} />
    </aside>
  </main>;
}

function AirportDetails({ airport, receiver, details, metar, taf, onShowRunways, onClose, activity, onSelectAircraft }) {
  const kinds = { large_airport: '大型机场', medium_airport: '中型机场', small_airport: '小型机场' };
  const country = airport.country || airport.countryiso2;
  const metres = (ft) => ft > 0 ? measure(Math.round(ft * 0.3048), 'm') : null;
  const observation = parseMETAR(metar?.rawOb);
  const nearby = activity.flatMap((point) => {
    const distance = stationObservation(airport, point)?.distance;
    const nearGround = point.on_ground || (airport.elevation_ft != null && point.alt_baro != null && Math.abs(point.alt_baro - airport.elevation_ft) <= 3000);
    return distance != null && distance <= 15 && nearGround ? [{ point, distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
  const ceiling = observation.clouds.filter(({ amount, feet }) => feet != null && ['BKN', 'OVC', 'VV'].includes(amount));
  const cloudNames = { FEW: '少云', SCT: '疏云', BKN: '多云', OVC: '阴天', VV: '垂直能见度' };
  const weatherNames = { FG: '雾', BR: '轻雾', HZ: '霾', RA: '雨', SN: '雪', DZ: '毛毛雨', TS: '雷暴', TSRA: '雷雨', FZRA: '冻雨', SHRA: '阵雨' };
  return <section className="aircraft-details">
    <header><div><h1>{airport.name || airport.icao || airport.id}</h1>
      {airport.type && <span className="target-state">{kinds[airport.type]}</span>}</div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="关闭机场详情">×</button>
    </header>
    <section className="detail-section" aria-label="机场资料">
      <h2>机场资料 <a href={airport.id ? 'https://ourairports.com/data/' : 'https://github.com/vradarserver/standing-data'} target="_blank" rel="noreferrer">{airport.id ? 'OurAirports' : 'VRS'}</a></h2>
      <dl className="metrics">
        {airport.icao && <div><dt>ICAO</dt><dd>{airport.icao}</dd></div>}
        {airport.iata && <div><dt>IATA</dt><dd>{airport.iata}</dd></div>}
        {(airport.city || airport.location) && <div><dt>城市</dt><dd>{airport.city || airport.location}</dd></div>}
        {country && <div><dt>国家或地区</dt><dd>{country}</dd></div>}
        {(airport.elevation_ft ?? airport.alt_feet) != null && <div><dt>机场海拔</dt><dd>{measure(airport.elevation_ft ?? airport.alt_feet, 'ft')}</dd></div>}
        {airport.scheduled != null && <div><dt>定期航班</dt><dd>{airport.scheduled ? '有' : '无'}</dd></div>}
        <div><dt>纬度</dt><dd>{airport.lat.toFixed(5)}</dd></div><div><dt>经度</dt><dd>{airport.lon.toFixed(5)}</dd></div>
        {receiver && <div><dt>距接收站</dt><dd>{measure(stationDistance(airport, receiver), 'km')}</dd></div>}
      </dl>
    </section>
    {(metar?.rawOb || taf?.rawTAF) && <section className="detail-section airport-weather" aria-label="航空天气">
      <h2>航空天气 <a href="https://aviationweather.gov/" target="_blank" rel="noreferrer">AWC</a></h2>
      {metar?.rawOb && <><div className="airport-data-heading">METAR · {timeLabel(metar.reportTime)}</div>
        <dl className="metrics">
          {metar.temp != null && <div><dt>温度</dt><dd>{measure(metar.temp, '°C')}</dd></div>}
          {metar.dewp != null && <div><dt>露点</dt><dd>{measure(metar.dewp, '°C')}</dd></div>}
          {metar.wspd != null && <div><dt>风</dt><dd>{typeof metar.wdir === 'number' ? `${metar.wdir}° · ` : metar.wdir === 'VRB' ? '风向不定 · ' : ''}{measure(metar.wspd, 'kt')}{metar.wgst != null && ` / 阵风 ${metar.wgst} kt`}</dd></div>}
          {(observation.visibility || metar.visib != null) && <div><dt>能见度</dt><dd>{observation.visibility || `${metar.visib} SM`}</dd></div>}
          {metar.altim != null && <div><dt>气压</dt><dd>{measure(metar.altim, 'hPa')}</dd></div>}
          {metar.fltCat && <div><dt>飞行天气类别</dt><dd>{metar.fltCat}</dd></div>}
          {!!ceiling.length && <div><dt>最低云幕（机场上空）</dt><dd>{measure(Math.min(...ceiling.map(({ feet }) => feet)), 'ft')}</dd></div>}
          {!!observation.phenomena.length && <div className="wide"><dt>天气现象</dt><dd>{observation.phenomena.map((code) => {
            const name = weatherNames[code.replace(/^[+-]/, '')];
            return name ? `${name} (${code})` : code;
          }).join(' / ')}</dd></div>}
          {!!observation.clouds.length && <div className="wide"><dt>云层（机场上空）</dt><dd>{observation.clouds.map(({ amount, feet, type }) =>
            [cloudNames[amount], feet == null ? '高度未报' : measure(feet, 'ft'), type].filter(Boolean).join(' ')).join(' / ')}</dd></div>}
        </dl>
        <div className="airport-data-heading">跑道视程（RVR）{!observation.rvr.length && ' · 未报告'}</div>
        {!!observation.rvr.length && <ul className="airport-data-list" aria-label="跑道视程">{observation.rvr.map((range, i) => <li key={`${range.runway}/${i}`}>
          <strong>{range.runway}</strong><span>{formatRVR(range)}</span>
        </li>)}</ul>}
        <details><summary>METAR 原文</summary><code>{metar.rawOb}</code></details></>}
      {taf?.rawTAF && <details><summary>TAF 预报 · {timeLabel(taf.issueTime)}</summary>
        {taf.validTimeFrom && taf.validTimeTo && <p>有效期：{timeLabel(taf.validTimeFrom * 1000)} 至 {timeLabel(taf.validTimeTo * 1000)}</p>}
        <code>{taf.rawTAF}</code></details>}
    </section>}
    {!!details?.runways.length && <section className="detail-section" aria-label="跑道">
      <h2>跑道 <a href="https://ourairports.com/data/" target="_blank" rel="noreferrer">OurAirports</a></h2>
      <ul className="airport-data-list">{details.runways.map((runway, i) => <li key={`${runway.low}/${runway.high}/${i}`}>
        <strong>{[runway.low, runway.high].filter(Boolean).join(' / ') || '未编号'}</strong>
        <span>{[ [metres(runway.length_ft), metres(runway.width_ft)].filter(Boolean).join(' × '), runway.surface, runway.lighted && '有灯光', runway.closed && '目录标为关闭' ].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
      {details.runways.some(({ start, end, low, high }) => (start && low) || (end && high)) && <button type="button" className="primary follow-button" onClick={onShowRunways}>查看跑道地图</button>}
    </section>}
    <section className="detail-section" aria-label="机场附近活动"><h2>附近活动 · 本地观测</h2>
      {nearby.length ? <ul className="airport-data-list">{nearby.map(({ point, distance }) => <li key={point.hex}>
        <button className="analysis-button" type="button" onClick={() => onSelectAircraft(point)}>{point.flight || point.hex}</button>
        <span>{point.on_ground ? '地面' : measure(point.alt_baro, 'ft')} · {measure(distance, 'km')}</span>
      </li>)}</ul> : <p className="analysis-caption">15 km 内暂无低空或地面目标</p>}
    </section>
    {!!details?.frequencies.length && <section className="detail-section" aria-label="通信频率">
      <h2>通信频率 <a href="https://ourairports.com/data/" target="_blank" rel="noreferrer">OurAirports</a></h2>
      <ul className="airport-data-list">{details.frequencies.map(({ type, description, mhz }, i) => <li key={`${type}/${mhz}/${i}`}>
        <strong title={description}>{type || description}</strong><span>{Number(mhz).toFixed(3)} MHz</span>
      </li>)}</ul>
    </section>}
  </section>;
}

function sampleAge(point, serverNow) {
  return Number.isFinite(serverNow) ? Math.max(0, Math.floor((serverNow - Date.parse(point.position_at)) / 1000)) : null;
}

function TrafficTable({ points, receiver, serverNow, selectedHex, error, onSelect, historical }) {
  const [sort, setSort] = useState({ key: 'distance', direction: 1 });
  const [airframes, setAirframes] = useState(() => new Map());
  const targets = useRef([]);
  useEffect(() => {
    targets.current = points.map(({ hex }) => hex).filter((hex) => /^[0-9a-f]{6}$/i.test(hex));
  }, [points]);
  useEffect(() => {
    const controller = new AbortController();
    const checked = new Map();
    let timer;
    async function lookup() {
      const now = Date.now();
      const hex = targets.current.find((key) => (checked.get(key) ?? 0) <= now);
      let delay = 500;
      let timeout;
      try {
        if (!hex) return;
        const request = new AbortController();
        timeout = setTimeout(() => request.abort(), 6000);
        const response = await fetch(`/api/v1/aircraft/info?${new URLSearchParams({ hex })}`, {
          signal: AbortSignal.any([controller.signal, request.signal]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (controller.signal.aborted) return;
        checked.delete(hex);
        if (checked.size >= 512) checked.delete(checked.keys().next().value);
        checked.set(hex, Date.now() + (data ? 3600000 : 600000));
        setAirframes((previous) => {
          const next = new Map(previous);
          next.delete(hex);
          if (next.size >= 512) next.delete(next.keys().next().value);
          if (data) next.set(hex, data);
          return next;
        });
      } catch {
        // Back off across the whole table if the directory is unavailable.
        delay = 15000;
      } finally {
        clearTimeout(timeout);
        if (!controller.signal.aborted) timer = setTimeout(lookup, delay);
      }
    }
    lookup();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const columns = [
    ['call', '呼号 / HEX'], ['alt', '高度', 'ft'], ['speed', '地速', 'kt'],
    ['heading', '航迹', '°'], ['distance', '站距', 'km'], ['age', '更新', 's'], ['squawk', '应答码'],
  ];
  const rows = points.map((point) => ({ point, call: point.flight || point.hex.toUpperCase(),
    alt: point.on_ground ? 0 : point.alt_baro, speed: point.gs, heading: point.track,
    distance: stationDistance(point, receiver), age: sampleAge(point, serverNow), squawk: point.telemetry?.squawk,
  }));
  rows.sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (x == null || y == null) return Number(x == null) - Number(y == null) || a.call.localeCompare(b.call);
    return sort.direction * (typeof x === 'string' ? x.localeCompare(y) : x - y) || a.call.localeCompare(b.call);
  });
  const title = historical ? '回放目标' : '附近飞机';
  return <section className="traffic-panel" aria-label={title}>
    <div className="traffic-heading"><h2>{title} <span>{points.length}</span></h2>{error && <small role="status">实时连接中断</small>}</div>
    <div className="aircraft-table">
      <table aria-label={title}>
        <thead><tr>{columns.map(([key, label, unit]) => <th key={key} scope="col"
          aria-sort={sort.key === key ? (sort.direction > 0 ? 'ascending' : 'descending') : 'none'}>
          <button type="button" onClick={() => setSort({ key, direction: sort.key === key ? -sort.direction : 1 })}>
            {label}{sort.key === key && <span aria-hidden="true"> {sort.direction > 0 ? '▴' : '▾'}</span>}
            {unit && <small>{unit}</small>}
          </button></th>)}</tr></thead>
        <tbody>{rows.map(({ point, call, alt, speed, heading, distance, age, squawk }) => {
          const info = airframes.get(point.hex);
          const registration = point.telemetry?.r?.trim().toUpperCase();
          const matched = info && (!registration || registration === info.registration?.trim().toUpperCase()) ? info : null;
          const type = (point.telemetry?.t || matched?.icao_type)?.trim().toUpperCase();
          const country = matched?.registered_owner_country_iso_name?.toLowerCase();
          return <tr key={point.hex}
          className={point.hex === selectedHex ? 'chosen' : ''} onClick={() => onSelect(point)}>
          <td><button type="button" aria-pressed={point.hex === selectedHex}>{call}</button>
            {(point.flight || type || country) && <small className="aircraft-identity">
              {point.flight && <span>{point.hex.toUpperCase()}</span>}
              {type && <span className="type-badge">{type}</span>}
              {/^[a-z]{2}$/.test(country ?? '') && <img key={country} src={`https://flagcdn.com/w40/${country}.png`}
                width="14" height="10" alt={matched.registered_owner_country_name || country.toUpperCase()}
                title={matched.registered_owner_country_name || country.toUpperCase()} loading="lazy" referrerPolicy="no-referrer"
                onError={(event) => { event.currentTarget.hidden = true; }} />}
            </small>}
          </td>
          <td style={{ color: altitudeColor(alt) }}>{point.on_ground ? '地面' : measure(alt)}</td>
          <td>{measure(speed)}</td><td>{measure(heading)}</td><td>{measure(distance)}</td><td>{measure(age)}</td><td>{squawk ?? '—'}</td>
        </tr>; })}</tbody>
      </table>
      {!rows.length && <p className="notice">暂无飞机</p>}
    </div>
  </section>;
}

const manufacturerLogos = [
  [/^boeing\b/i, 'Boeing', '4/4f/Boeing_full_logo.svg'],
  [/^airbus\b/i, 'Airbus', '5/5d/Airbus_Logo_2017.svg'],
  [/^embraer\b/i, 'Embraer', '5/54/Embraer_logo.svg'],
];

function ManufacturerLogo({ brand, file }) {
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  return <a className="manufacturer-logo" href={`https://commons.wikimedia.org/wiki/File:${file.split('/').at(-1)}`}
    target="_blank" rel="noreferrer">
    <img src={`https://upload.wikimedia.org/wikipedia/commons/${file}`} alt={`${brand} Logo`}
      decoding="async" referrerPolicy="no-referrer" onError={() => setUnavailable(true)} />
  </a>;
}

function OptionalMetrics({ title, fields }) {
  const available = fields.filter(([, value]) => value != null && value !== '');
  if (!available.length) return null;
  return <section className="detail-section" aria-label={title}><h2>{title}</h2><dl className="metrics">
    {available.map(([label, value, unit]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? measure(value, unit) : value}</dd></div>)}
  </dl></section>;
}

function AircraftDetails({ point, onClose, following, onFollow, isLive, receiver, serverNow, referenceRoute, onLocateAirport }) {
  const hex = point?.hex;
  const info = usePoll(/^[0-9a-f]{6}$/i.test(hex ?? '') ? `aircraft/info?${new URLSearchParams({ hex })}` : null, 0);
  const aircraft = info?.data;
  const t = point?.telemetry ?? {};
  const sameAirframe = aircraft && (!t.r || t.r.trim().toUpperCase() === aircraft.registration?.trim().toUpperCase());
  const registration = (t.r || aircraft?.registration)?.trim().toUpperCase();
  const code = (t.t || (sameAirframe ? aircraft.icao_type : null))?.trim().toUpperCase();
  const model = t.desc || (sameAirframe && [aircraft.manufacturer, aircraft.type].filter(Boolean).join(' '));
  const logo = manufacturerLogos.find(([pattern]) => pattern.test((sameAirframe && aircraft.manufacturer) || model || ''));
  return <section className="aircraft-details">
    <header><div><h1>{point?.flight || point?.hex.toUpperCase() || '飞机详情'}</h1>
      {point && <span className={`target-state${isLive ? ' is-live' : ''}`}>{point.historical ? '历史采样' : isLive ? '实时' : '最后位置'}</span>}</div>
      {onClose && <button className="close" onClick={onClose} aria-label="清除选中飞机">×</button>}
    </header>
    {onFollow && <button type="button" className="primary follow-button" aria-pressed={following} onClick={onFollow}>
      {following ? '停止跟随' : '跟随飞机'}
    </button>}
    {registration && <AircraftPhoto key={registration} registration={registration} />}
    <ReferenceRoute route={referenceRoute} onLocate={onLocateAirport} />
    {(code || registration || model) && <section className="detail-section" aria-label="机身资料">
      <h2>机身资料 {aircraft && <a href="https://www.adsbdb.com/" target="_blank" rel="noreferrer">adsbdb</a>}</h2>
      <div className="airframe-heading"><strong>{model || '机身资料'}</strong>
        {code && <span>{code}</span>}</div>
      {logo && <ManufacturerLogo key={logo[1]} brand={logo[1]} file={logo[2]} />}
      <dl className="metrics">
        {registration && <div><dt>注册号</dt><dd>{registration}</dd></div>}
        {t.category && <div><dt>发射机类别</dt><dd>{t.category}</dd></div>}
        {sameAirframe && aircraft.registered_owner_country_name && <div><dt>注册国家或地区</dt><dd>{aircraft.registered_owner_country_name}</dd></div>}
        {sameAirframe && aircraft.registered_owner && <div className="wide"><dt>登记所有人</dt><dd>{aircraft.registered_owner}</dd></div>}
      </dl>
    </section>}
    {point && <><section className="detail-section" aria-label="飞行数据"><h2>飞行数据</h2><dl className="metrics">
      <div><dt>气压高度</dt><dd>{point.on_ground ? '地面' : measure(point.alt_baro, 'ft')}</dd></div>
      <div><dt>地速</dt><dd>{measure(point.gs, 'kt')}</dd></div>
      <div><dt>航迹角</dt><dd>{measure(point.track, '°')}</dd></div>
      <div><dt>距接收站</dt><dd>{measure(stationDistance(point, receiver), 'km')}</dd></div>
      <div><dt>纬度</dt><dd>{point.lat.toFixed(5)}</dd></div>
      <div><dt>经度</dt><dd>{point.lon.toFixed(5)}</dd></div>
    </dl></section>
      <OptionalMetrics title="高度与空速" fields={[
        ['几何高度', t.alt_geom, 'ft'], ['气压垂直速度', t.baro_rate, 'ft/min'], ['几何垂直速度', t.geom_rate, 'ft/min'],
        ['指示空速', t.ias, 'kt'], ['真空速', t.tas, 'kt'], ['马赫数', t.mach?.toFixed(3)],
        ['磁航向', t.mag_heading, '°'], ['真航向', t.true_heading, '°'], ['横滚角', t.roll, '°'],
        ['估算风向', t.wd, '°'], ['估算风速', t.ws, 'kt'], ['估算外温', t.oat, '°C'],
      ]} />
      <OptionalMetrics title="导航设定" fields={[
        ['MCP 选定高度', t.nav_altitude_mcp, 'ft'], ['FMS 选定高度', t.nav_altitude_fms, 'ft'],
        ['选定航向', t.nav_heading, '°'], ['气压设定', t.nav_qnh, 'hPa'], ['导航模式', t.nav_modes?.join(' / ')],
      ]} />
      <section className="detail-section" aria-label="接收数据"><h2>接收数据</h2><dl className="metrics">
      <div><dt>{point.hex.startsWith('~') ? '目标地址' : 'ICAO 24 位地址'}</dt><dd>{point.hex.toUpperCase()}</dd></div>
      {isLive && <div><dt>位置更新</dt><dd>{measure(sampleAge(point, serverNow), '秒前')}</dd></div>}
      {t.squawk != null && <div><dt>应答码</dt><dd>{t.squawk}</dd></div>}
      {t.type && <div><dt>数据来源</dt><dd>{t.type.toUpperCase()}</dd></div>}
      {t.rssi != null && <div><dt>接收信号</dt><dd>{measure(t.rssi, 'dBFS')}</dd></div>}
      {t.messages != null && <div><dt>累计报文</dt><dd>{measure(t.messages)}</dd></div>}
      {t.emergency && t.emergency !== 'none' && <div><dt>应急状态</dt><dd>{t.emergency}</dd></div>}
      {t.nic != null && <div><dt>完整性等级（NIC）</dt><dd>{t.nic}</dd></div>}
      {t.nac_p != null && <div><dt>位置精度等级（NACp）</dt><dd>{t.nac_p}</dd></div>}
      {t.rc != null && <div><dt>位置包容半径</dt><dd>{measure(t.rc, 'm')}</dd></div>}
      {t.version != null && <div><dt>ADS-B 版本</dt><dd>{t.version}</dd></div>}
      <div className="wide"><dt>{point.historical ? '历史采样时间' : '最后位置时间'}</dt><dd>{timeLabel(point.position_at)}{point.position_at_approximate && ' · 近似'}</dd></div>
    </dl></section></>}
  </section>;
}

createRoot(document.getElementById('root')).render(<App />);
