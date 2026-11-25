import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { api, type MqttSettings } from '../api.ts';

const DEFAULT_PORTS: Record<MqttSettings['protocol'], number> = { mqtt: 1883, mqtts: 8883, ws: 80, wss: 443 };

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <label class={wide ? 'field wide' : 'field'}>
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function MqttPage({ onSaved }: { onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<MqttSettings>();
  const [saved, setSaved] = useState<MqttSettings>();
  const [clearPassword, setClearPassword] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [busy, setBusy] = useState<'test' | 'save'>();

  useEffect(() => {
    void api.settings().then((s) => {
      setForm(s.mqtt);
      setSaved(s.mqtt);
    });
  }, []);

  if (!form || !saved) return <p class="muted">Loading…</p>;

  const set = <K extends keyof MqttSettings>(key: K, value: MqttSettings[K]) => setForm({ ...form, [key]: value });
  const setTls = <K extends keyof MqttSettings['tls']>(key: K, value: MqttSettings['tls'][K]) => setForm({ ...form, tls: { ...form.tls, [key]: value } });
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  const tls = form.protocol === 'mqtts' || form.protocol === 'wss';
  const ws = form.protocol === 'ws' || form.protocol === 'wss';

  /** null keeps the saved secret; '' clears it. */
  const payload = (): MqttSettings => ({
    ...form,
    password: clearPassword ? '' : form.password || null,
    tls: { ...form.tls, key: clearKey ? '' : form.tls.key || null },
  });

  const test = async () => {
    setBusy('test');
    setResult(undefined);
    try {
      setResult(await api.testMqtt(payload()));
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const save = async (event: Event) => {
    event.preventDefault();
    if (form.base_topic !== saved.base_topic
      && !confirm(`Change the base topic from "${saved.base_topic}" to "${form.base_topic}"? Everything under the old one is cleared, and subscribers must be pointed at the new one.`)) return;
    setBusy('save');
    setResult(undefined);
    try {
      await api.saveMqtt(payload());
      const fresh = await api.settings();
      setForm(fresh.mqtt);
      setSaved(fresh.mqtt);
      setClearPassword(false);
      setClearKey(false);
      setResult({ ok: true, message: 'Saved. Reconnecting with the new settings.' });
      await onSaved();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <form class="settings" onSubmit={(e) => void save(e)}>
      <fieldset>
        <legend>Broker</legend>
        <div class="fields">
          <Field label="Protocol">
            <select value={form.protocol} onChange={(e) => {
              const protocol = e.currentTarget.value as MqttSettings['protocol'];
              setForm({ ...form, protocol, port: form.port === DEFAULT_PORTS[form.protocol] ? DEFAULT_PORTS[protocol] : form.port });
            }}>
              <option value="mqtt">mqtt:// (TCP)</option>
              <option value="mqtts">mqtts:// (TCP + TLS)</option>
              <option value="ws">ws:// (WebSocket)</option>
              <option value="wss">wss:// (WebSocket + TLS)</option>
            </select>
          </Field>
          <Field label="Host" hint="Name or IP address of the broker, e.g. 192.168.1.100">
            <input value={form.host} onInput={(e) => set('host', e.currentTarget.value)} placeholder="192.168.1.100" required autoComplete="off" spellcheck={false} />
          </Field>
          <Field label="Port">
            <input type="number" min={1} max={65535} value={form.port} onInput={(e) => set('port', num(e))} required />
          </Field>
          {ws && (
            <Field label="WebSocket path">
              <input value={form.path} onInput={(e) => set('path', e.currentTarget.value)} placeholder="/mqtt" />
            </Field>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Authentication</legend>
        <div class="fields">
          <Field label="Username" hint="Leave empty for an anonymous broker">
            <input value={form.username} onInput={(e) => set('username', e.currentTarget.value)} autoComplete="off" spellcheck={false} />
          </Field>
          <Field label="Password" hint={saved.password_set ? 'Saved; leave empty to keep it' : undefined}>
            <input type="password" value={form.password ?? ''} onInput={(e) => set('password', e.currentTarget.value)}
              placeholder={saved.password_set ? '••••••••' : ''} autoComplete="new-password" disabled={clearPassword} />
          </Field>
          {saved.password_set && (
            <label class="check">
              <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.currentTarget.checked)} />
              Remove the saved password
            </label>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Topics and publishing</legend>
        <div class="fields">
          <Field label="Base topic" hint="Like Zigbee2MQTT's base_topic. Use a different one from Zigbee2MQTT's own.">
            <input value={form.base_topic} onInput={(e) => set('base_topic', e.currentTarget.value)} required spellcheck={false} />
          </Field>
          <Field label="QoS for readings" hint="Bridge topics always use QoS 1">
            <select value={form.qos} onChange={(e) => set('qos', Number(e.currentTarget.value) as MqttSettings['qos'])}>
              <option value={0}>0: at most once</option>
              <option value={1}>1: at least once</option>
              <option value={2}>2: exactly once</option>
            </select>
          </Field>
          <label class="check">
            <input type="checkbox" checked={form.retain} onChange={(e) => set('retain', e.currentTarget.checked)} />
            Retain readings, so a new subscriber gets the latest one at once
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Session</legend>
        <div class="fields">
          <Field label="Client ID" hint="Must be unique on the broker">
            <input value={form.client_id} onInput={(e) => set('client_id', e.currentTarget.value)} required spellcheck={false} />
          </Field>
          <Field label="MQTT version">
            <select value={form.version} onChange={(e) => set('version', Number(e.currentTarget.value) as MqttSettings['version'])}>
              <option value={3}>3.1</option>
              <option value={4}>3.1.1</option>
              <option value={5}>5.0</option>
            </select>
          </Field>
          <Field label="Keepalive (s)">
            <input type="number" min={0} max={65535} value={form.keepalive} onInput={(e) => set('keepalive', num(e))} />
          </Field>
          <Field label="Connect timeout (s)">
            <input type="number" min={1} max={300} value={form.connect_timeout} onInput={(e) => set('connect_timeout', num(e))} />
          </Field>
          <Field label="Reconnect every (s)">
            <input type="number" min={1} max={3600} value={form.reconnect_period} onInput={(e) => set('reconnect_period', num(e))} />
          </Field>
          <label class="check">
            <input type="checkbox" checked={form.clean} onChange={(e) => set('clean', e.currentTarget.checked)} />
            Clean session
          </label>
        </div>
      </fieldset>

      {tls && (
        <fieldset>
          <legend>TLS</legend>
          <div class="fields">
            <label class="check wide">
              <input type="checkbox" checked={form.tls.reject_unauthorized} onChange={(e) => setTls('reject_unauthorized', e.currentTarget.checked)} />
              Verify the broker's certificate (turn off only for a self-signed one without its CA below)
            </label>
            <Field label="CA certificate (PEM)" hint="For a private CA; empty uses the system's trusted CAs" wide>
              <textarea rows={4} value={form.tls.ca} onInput={(e) => setTls('ca', e.currentTarget.value)} placeholder="-----BEGIN CERTIFICATE-----" spellcheck={false} />
            </Field>
            <Field label="Client certificate (PEM)" hint="Only for brokers that require client certificates" wide>
              <textarea rows={4} value={form.tls.cert} onInput={(e) => setTls('cert', e.currentTarget.value)} placeholder="-----BEGIN CERTIFICATE-----" spellcheck={false} />
            </Field>
            <Field label="Client key (PEM)" hint={saved.tls.key_set ? 'Saved; leave empty to keep it' : undefined} wide>
              <textarea rows={4} value={form.tls.key ?? ''} onInput={(e) => setTls('key', e.currentTarget.value)}
                placeholder={saved.tls.key_set ? '(saved key kept)' : '-----BEGIN PRIVATE KEY-----'} spellcheck={false} disabled={clearKey} />
            </Field>
            {saved.tls.key_set && (
              <label class="check">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.currentTarget.checked)} />
                Remove the saved key
              </label>
            )}
          </div>
        </fieldset>
      )}

      {result && <div class={result.ok ? 'banner ok' : 'banner error'} role="status">{result.message}</div>}
      <div class="form-actions">
        <button type="button" class="button" onClick={() => void test()} disabled={busy !== undefined}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button class="button primary" disabled={busy !== undefined}>{busy === 'save' ? 'Saving…' : 'Save and reconnect'}</button>
      </div>
    </form>
  );
}
