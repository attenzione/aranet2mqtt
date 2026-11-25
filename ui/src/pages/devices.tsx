import { useState } from 'preact/hooks';

import { api, type DeviceStatus, type Measured, type NearbyStatus, type Status } from '../api.ts';
import { AIR_QUALITY, ago } from '../format.ts';

function Readings({ state }: { state: Measured }) {
  const quality = AIR_QUALITY[state.air_quality] ?? AIR_QUALITY.unknown!;
  return (
    <dl class="readings">
      <div class="co2">
        <dt>CO₂</dt>
        <dd>
          <span class={`level ${quality.light}`} aria-hidden="true" />
          {state.co2}<small> ppm · {quality.label}</small>
        </dd>
      </div>
      <div><dt>Temperature</dt><dd>{state.temperature.toFixed(1)}<small> °C</small></dd></div>
      <div><dt>Humidity</dt><dd>{state.humidity}<small> %</small></dd></div>
      <div><dt>Pressure</dt><dd>{state.pressure.toFixed(1)}<small> hPa</small></dd></div>
      <div><dt>Battery</dt><dd>{state.battery}<small> %</small></dd></div>
    </dl>
  );
}

function DeviceCard({ device, base, onChange }: { device: DeviceStatus; base: string; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.friendly_name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
      await onChange();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async (event: Event) => {
    event.preventDefault();
    if (await run(() => api.renameDevice(device.ieee_address, name))) setEditing(false);
  };

  const remove = async () => {
    if (!confirm(`Remove "${device.friendly_name}"? Its retained MQTT topics are cleared. It comes back only when you add it again.`)) return;
    await run(() => api.removeDevice(device.ieee_address));
  };

  const availability = device.available === null ? 'unknown' : device.available ? 'online' : 'offline';
  return (
    <article class="card">
      <div class="card-head">
        {editing
          ? (
            <form class="rename" onSubmit={(e) => void rename(e)}>
              <input value={name} onInput={(e) => setName(e.currentTarget.value)} aria-label="Friendly name" autoFocus />
              <button class="button primary small" disabled={busy}>Save</button>
              <button type="button" class="button small" onClick={() => { setEditing(false); setName(device.friendly_name); }}>Cancel</button>
            </form>
          )
          : <h3>{device.friendly_name}</h3>}
        <span class={`badge ${availability}`}>{availability}</span>
      </div>
      <p class="meta">
        {device.model} · {device.ble_name}{device.address && ` · ${device.address}`} · heard {ago(device.last_seen)}
      </p>
      {device.state ? <Readings state={device.state} /> : <p class="muted">No reading since aranet2mqtt started.</p>}
      <p class="topic"><code>{base}/{device.friendly_name}</code></p>
      {error && <p class="field-error">{error}</p>}
      {!editing && (
        <div class="actions">
          <button type="button" class="button small" onClick={() => setEditing(true)}>Rename</button>
          <button type="button" class="button small danger" onClick={() => void remove()} disabled={busy}>Remove</button>
        </div>
      )}
    </article>
  );
}

function NearbyRow({ sensor, onChange }: { sensor: NearbyStatus; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.addDevice(sensor.name);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>
        <strong>{sensor.name}</strong>
        <div class="meta">{sensor.address ?? 'address not known yet'}</div>
        {error && <div class="field-error">{error}</div>}
      </td>
      <td>{sensor.state ? `${sensor.state.co2} ppm · ${sensor.state.temperature.toFixed(1)} °C` : sensor.supported ? 'no reading yet' : '—'}</td>
      <td>{ago(sensor.last_seen)}</td>
      <td class="right">
        {sensor.supported
          ? <button type="button" class="button small primary" onClick={() => void add()} disabled={busy}>Add</button>
          : <span class="muted">{sensor.model} not supported</span>}
      </td>
    </tr>
  );
}

export function DevicesPage({ status, onChange }: { status: Status | undefined; onChange: () => Promise<void> }) {
  if (!status) return <p class="muted">Loading…</p>;
  const { devices, nearby, mqtt, bluetooth } = status;
  return (
    <>
      {!mqtt.configured && (
        <div class="banner warn">No MQTT broker is set up yet, so nothing is published. <a href="#/mqtt">Set up the broker</a>.</div>
      )}
      {bluetooth.state === 'error' && <div class="banner error">Bluetooth: {bluetooth.message ?? 'the listener failed'}</div>}

      <section>
        <div class="section-head">
          <h2>Devices <span class="count">{devices.length}</span></h2>
        </div>
        {devices.length === 0
          ? <p class="empty">No sensors added yet. Add one from the list below, or press <strong>Permit join</strong> to add every Aranet4 heard nearby.</p>
          : <div class="grid">{devices.map((d) => <DeviceCard key={d.ieee_address} device={d} base={mqtt.base_topic} onChange={onChange} />)}</div>}
      </section>

      <section>
        <div class="section-head">
          <h2>Heard nearby <span class="count">{nearby.length}</span></h2>
          <button type="button" class="button small" onClick={() => void api.discover().then(() => setTimeout(() => void onChange(), 16_000))}>
            Scan now
          </button>
        </div>
        {nearby.length === 0
          ? <p class="empty">No other Aranet sensors heard. A sensor shows up here once its broadcast is heard; it needs <strong>Smart Home integration</strong> switched on in the Aranet Home app.</p>
          : (
            <div class="table-wrap">
              <table>
                <thead><tr><th>Sensor</th><th>Latest</th><th>Heard</th><th /></tr></thead>
                <tbody>{nearby.map((n) => <NearbyRow key={n.name} sensor={n} onChange={onChange} />)}</tbody>
              </table>
            </div>
          )}
      </section>
    </>
  );
}
