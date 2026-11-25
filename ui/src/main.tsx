import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { api, type Status } from './api.ts';
import { DevicesPage } from './pages/devices.tsx';
import { LogsPage } from './pages/logs.tsx';
import { MqttPage } from './pages/mqtt.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { Header } from './header.tsx';
import './styles.css';

const PAGES = [
  { id: 'devices', label: 'Devices' },
  { id: 'mqtt', label: 'MQTT' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

function currentPage(): PageId {
  const id = location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === id) ? (id as PageId) : 'devices';
}

function App() {
  const [page, setPage] = useState<PageId>(currentPage);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const onHash = () => setPage(currentPage());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <Header status={status} onChange={refresh} />
      <nav class="tabs" aria-label="Sections">
        <div class="wrap">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} class={page === p.id ? 'tab active' : 'tab'} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </div>
      </nav>
      <main class="wrap">
        {error && <div class="banner error">Can't reach aranet2mqtt: {error}</div>}
        {page === 'devices' && <DevicesPage status={status} onChange={refresh} />}
        {page === 'mqtt' && <MqttPage onSaved={refresh} />}
        {page === 'settings' && <SettingsPage />}
        {page === 'logs' && <LogsPage />}
      </main>
      {status && (
        <footer class="wrap footer">
          aranet2mqtt {status.version} · reports Zigbee2MQTT {status.z2m_version} · upstream aranet {status.commit} · bridge {status.ieee_address}
        </footer>
      )}
    </>
  );
}

render(<App />, document.getElementById('app')!);
