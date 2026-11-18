import React, { useEffect, useState } from 'react';

export default function AircraftSearch({ stationID, onPick }) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const term = input.trim();
  const data = result && result.term === term && result.stationID === stationID ? result : null;

  useEffect(() => {
    if (!stationID || !term || !open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const now = Date.now();
        const params = new URLSearchParams({ receiver_id: stationID, q: term,
          from: new Date(now - 86400000).toISOString(), to: new Date(now + 1000).toISOString() });
        const response = await fetch(`/api/v1/aircraft?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const matches = await response.json();
        if (!controller.signal.aborted) setResult({ stationID, term, matches });
      } catch {
        if (!controller.signal.aborted) setResult({ stationID, term, error: true });
      }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [stationID, term, open]);

  function choose(match) {
    onPick(match);
    setOpen(false);
    setInput('');
  }

  return <section className="aircraft-search" aria-label="搜索飞机" onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  }}>
    <form className="search-entry" onSubmit={(e) => {
      e.preventDefault();
      if (data?.matches?.length) choose(data.matches[0]);
    }}>
      <span className="search-icon" aria-hidden="true" />
      <input value={input} placeholder="搜索呼号 / HEX" aria-label="搜索呼号或 HEX" autoComplete="off" disabled={!stationID}
        onFocus={() => setOpen(true)} onChange={(e) => { setInput(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
    </form>
    {open && term && <div className="search-results">
      {data?.matches?.map((match) => <button key={match.hex} type="button" onClick={() => choose(match)}>
        <strong>{match.flight || match.hex}</strong><span>{match.flight && match.hex}</span>
      </button>)}
      <p role="status">{data?.error ? '搜索失败' : !data ? '搜索中…' : !data.matches.length ? '未找到飞机' : null}</p>
    </div>}
  </section>;
}
