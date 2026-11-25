import { useEffect, useState } from 'preact/hooks';

import { api, type Status } from './api.ts';
import { countdown } from './format.ts';

const JOIN_SECONDS = 254;

function Chip({ tone, label, title }: { tone: 'ok' | 'warn' | 'bad' | 'idle'; label: string; title?: string }) {
  return <span class={`chip ${tone}`} title={title}><span class="dot" aria-hidden="true" />{label}</span>;
}

export function Header({ status, onChange }: { status: Status | undefined; onChange: () => Promise<void> }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const join = status?.permit_join;

  useEffect(() => {
    if (!join?.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [join?.active]);

  const toggleJoin = async () => {
    setBusy(true);
    try {
      await api.permitJoin(join?.active ? 0 : JOIN_SECONDS);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const mqtt = status?.mqtt;
  const bt = status?.bluetooth;
  return (
    <header class="header">
      <div class="wrap header-row">
        <div class="brand">
          <span class="logo" aria-hidden="true">CO₂</span>
          <span>aranet2mqtt</span>
        </div>
        <div class="chips">
          {mqtt && (!mqtt.configured
            ? <Chip tone="warn" label="MQTT not set up" />
            : mqtt.connected
              ? <Chip tone="ok" label={`MQTT · ${mqtt.base_topic}`} title={mqtt.url} />
              : <Chip tone="bad" label="MQTT offline" title={mqtt.error ?? mqtt.url} />)}
          {bt && (bt.state === 'running'
            ? <Chip tone="ok" label="Bluetooth" title={bt.lastReadingAt ? `Last reading ${new Date(bt.lastReadingAt).toLocaleTimeString()}` : undefined} />
            : bt.state === 'error'
              ? <Chip tone="bad" label="Bluetooth error" title={bt.message} />
              : <Chip tone="idle" label={`Bluetooth ${bt.state}`} />)}
        </div>
        <button type="button" class={join?.active ? 'button join active' : 'button join'} onClick={() => void toggleJoin()} disabled={busy || !status}>
          {join?.active && join.end ? `Stop joining (${countdown(join.end, now)})` : 'Permit join'}
        </button>
      </div>
    </header>
  );
}
