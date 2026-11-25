import { useEffect, useRef, useState } from 'preact/hooks';

import { api, type Level, type LogEntry } from '../api.ts';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [min, setMin] = useState<Level>('info');
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => void api.logs().then((r) => setEntries(r.entries)).catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const shown = entries.filter((e) => ORDER[e.level] >= ORDER[min]);

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, follow]);

  return (
    <section>
      <div class="section-head">
        <h2>Logs</h2>
        <div class="log-controls">
          <label class="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
            Follow
          </label>
          <select value={min} onChange={(e) => setMin(e.currentTarget.value as Level)} aria-label="Minimum level">
            <option value="debug">debug and up</option>
            <option value="info">info and up</option>
            <option value="warn">warn and up</option>
            <option value="error">error only</option>
          </select>
        </div>
      </div>
      <div class="logs" role="log">
        {shown.length === 0 && <p class="muted">Nothing logged at this level yet. The level saved under Settings decides what is kept.</p>}
        {shown.map((e, i) => (
          <div key={i} class={`log ${e.level}`}>
            <time>{new Date(e.time).toLocaleTimeString()}</time>
            <span class="lvl">{e.level}</span>
            <span class="msg">{e.message}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </section>
  );
}
