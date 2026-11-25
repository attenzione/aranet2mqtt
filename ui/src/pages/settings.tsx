import { useEffect, useState } from 'preact/hooks';

import { api, type AdvancedSettings, type Level } from '../api.ts';

export function SettingsPage() {
  const [form, setForm] = useState<AdvancedSettings>();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.settings().then(({ bluetooth, availability, log_level, z2m_version }) => setForm({ bluetooth, availability, log_level, z2m_version }));
  }, []);

  if (!form) return <p class="muted">Loading…</p>;

  const bt = (key: keyof AdvancedSettings['bluetooth'], value: number) => setForm({ ...form, bluetooth: { ...form.bluetooth, [key]: value } });
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      await api.saveAdvanced(form);
      setResult({ ok: true, message: 'Saved.' });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="settings" onSubmit={(e) => void save(e)}>
      <fieldset>
        <legend>Bluetooth</legend>
        <p class="legend-note">
          aranet2mqtt only listens to the sensors' broadcasts; it never connects to them. An Aranet4 measures every 1 to 10 minutes
          (set in the Aranet Home app), so listening more often than that only repeats the same values.
        </p>
        <div class="fields">
          <label class="field">
            <span class="label">Listen every (s)</span>
            <input type="number" min={5} max={3600} value={form.bluetooth.scan_interval} onInput={(e) => bt('scan_interval', num(e))} />
            <span class="hint">Pause between listens</span>
          </label>
          <label class="field">
            <span class="label">Listen for (s)</span>
            <input type="number" min={3} max={120} value={form.bluetooth.listen_duration} onInput={(e) => bt('listen_duration', num(e))} />
            <span class="hint">How long each listen lasts</span>
          </label>
          <label class="field">
            <span class="label">Address scan every (s)</span>
            <input type="number" min={60} max={86400} value={form.bluetooth.discovery_interval} onInput={(e) => bt('discovery_interval', num(e))} />
            <span class="hint">Learns each sensor's Bluetooth address</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Availability</legend>
        <div class="fields">
          <label class="field">
            <span class="label">Offline after (min)</span>
            <input type="number" min={1} max={1440} value={Math.round(form.availability.timeout / 60)}
              onInput={(e) => setForm({ ...form, availability: { timeout: num(e) * 60 } })} />
            <span class="hint">A sensor not heard for this long is published as offline</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Zigbee2MQTT compatibility</legend>
        <p class="legend-note">
          Clients read <code>version</code> in <code>bridge/info</code> as the Zigbee2MQTT version, and some refuse a bridge older than
          they support. aranet2mqtt's messages follow Zigbee2MQTT 2.x; its own version is sent as <code>coordinator.meta.revision</code>.
        </p>
        <div class="fields">
          <label class="field">
            <span class="label">Reported Zigbee2MQTT version</span>
            <input value={form.z2m_version} onInput={(e) => setForm({ ...form, z2m_version: e.currentTarget.value })}
              required pattern="\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?" spellcheck={false} />
            <span class="hint">Default 2.14.2</span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Logging</legend>
        <div class="fields">
          <label class="field">
            <span class="label">Log level</span>
            <select value={form.log_level} onChange={(e) => setForm({ ...form, log_level: e.currentTarget.value as Level })}>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </label>
        </div>
      </fieldset>

      {result && <div class={result.ok ? 'banner ok' : 'banner error'} role="status">{result.message}</div>}
      <div class="form-actions">
        <button class="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
