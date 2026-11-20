import React, { useState } from 'react';

const presets = [[30, '30 分钟'], [60, '1 小时'], [180, '3 小时'], [360, '6 小时'], [720, '12 小时'], [1440, '24 小时']];
const coverageFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export default function TrailControl({ range, onRange, history, ready, actions }) {
  const [custom, setCustom] = useState(false);
  const [invalidRange, setInvalidRange] = useState(false);
  const data = history?.data;

  function choose(minutes) {
    const now = Date.now();
    onRange(minutes ? { minutes, from: new Date(now - minutes * 60000).toISOString(), to: new Date(now).toISOString() } : null);
    setCustom(false);
  }

  function applyRange(e) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const from = new Date(fields.get('from')), to = new Date(fields.get('to'));
    if (!(to > from)) return setInvalidRange(true);
    onRange({ from: from.toISOString(), to: to.toISOString() });
    setInvalidRange(false);
    setCustom(false);
  }

  return <section className="trail-control" aria-label="全站航迹">
    <div className="trail-heading">
      <h2>全站航迹</h2>
      {range && <span role="status">{history?.error ? '加载失败' : data ? `${data.routes.length} 架 · ${data.point_count} 点` : '加载中…'}</span>}
    </div>
    {range && data?.first_position_at && <p className="trail-coverage">
      数据 {coverageFormat.formatRange(new Date(data.first_position_at), new Date(data.last_position_at))}
    </p>}
    {custom && <form className="custom-range" onSubmit={applyRange}>
      <label>开始<input name="from" type="datetime-local" required /></label>
      <label>结束<input name="to" type="datetime-local" required /></label>
      <button className="primary">应用</button>
      {invalidRange && <small role="status">时间范围无效</small>}
    </form>}
    <div className="track-ranges" role="group" aria-label="航迹时间范围">
      <button type="button" aria-pressed={!range && !custom} onClick={() => choose(0)}>实时</button>
      {presets.map(([minutes, label]) => <button key={minutes} type="button" disabled={!ready} aria-pressed={!custom && range?.minutes === minutes}
        onClick={() => choose(minutes)}>{label}</button>)}
      <button type="button" disabled={!ready} aria-expanded={custom} aria-pressed={custom || Boolean(range && !range.minutes)}
        onClick={() => { setCustom(!custom); setInvalidRange(false); }}>自选</button>
    </div>
    {actions}
  </section>;
}
