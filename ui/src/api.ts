/** The server's JSON API (src/web/server.ts). Types mirror src/bridge/bridge.ts. */

export interface Measured {
  co2: number;
  temperature: number;
  humidity: number;
  pressure: number;
  air_quality: 'excellent' | 'moderate' | 'poor' | 'unknown';
  battery: number;
}

export interface DeviceStatus {
  ieee_address: string;
  friendly_name: string;
  ble_name: string;
  address: string;
  model: string;
  available: boolean | null;
  last_seen: string | null;
  state: Measured | null;
}

export interface NearbyStatus {
  name: string;
  address: string | null;
  model: string;
  supported: boolean;
  rssi: number | null;
  last_seen: string;
  state: Measured | null;
}

export interface Status {
  version: string;
  z2m_version: string;
  commit: string;
  ieee_address: string;
  mqtt: { configured: boolean; connected: boolean; url?: string; error?: string; base_topic: string };
  bluetooth: { state: 'stopped' | 'starting' | 'running' | 'error'; message?: string; lastReadingAt?: string; lastDiscoveryAt?: string };
  permit_join: { active: boolean; end: number | null };
  devices: DeviceStatus[];
  nearby: NearbyStatus[];
}

export interface MqttSettings {
  protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  host: string;
  port: number;
  path: string;
  username: string;
  /** Empty from the server; sent as `null` to keep the saved one. */
  password: string | null;
  password_set?: boolean;
  client_id: string;
  base_topic: string;
  version: 3 | 4 | 5;
  keepalive: number;
  clean: boolean;
  connect_timeout: number;
  reconnect_period: number;
  qos: 0 | 1 | 2;
  retain: boolean;
  tls: { ca: string; cert: string; key: string | null; key_set?: boolean; reject_unauthorized: boolean };
}

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface AdvancedSettings {
  bluetooth: { scan_interval: number; listen_duration: number; discovery_interval: number };
  availability: { timeout: number };
  log_level: Level;
  /** Reported as the Zigbee2MQTT version in bridge/info. */
  z2m_version: string;
}

export interface Settings extends AdvancedSettings {
  mqtt: MqttSettings;
}

export interface LogEntry {
  time: string;
  level: Level;
  message: string;
}

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // location.origin never carries credentials, so this also works when the page
  // was opened as http://user:pass@host/, where a relative fetch would throw.
  const response = await fetch(new URL(path, location.origin), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `${response.status} ${response.statusText}`);
  return data as T;
}

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  settings: () => call<Settings>('GET', '/api/config'),
  saveMqtt: (mqtt: MqttSettings) => call<{ ok: true }>('PUT', '/api/config/mqtt', mqtt),
  testMqtt: (mqtt: MqttSettings) => call<{ ok: boolean; message: string }>('POST', '/api/mqtt/test', mqtt),
  saveAdvanced: (settings: AdvancedSettings) => call<{ ok: true }>('PUT', '/api/config/advanced', settings),
  permitJoin: (time: number) => call<{ time: number }>('POST', '/api/permit_join', { time }),
  discover: () => call<{ ok: true }>('POST', '/api/discover'),
  addDevice: (name: string, friendly_name?: string) => call<{ ieee_address: string }>('POST', '/api/devices', { name, friendly_name }),
  renameDevice: (ieee: string, friendly_name: string) => call<{ from: string; to: string }>('PATCH', `/api/devices/${encodeURIComponent(ieee)}`, { friendly_name }),
  removeDevice: (ieee: string) => call<unknown>('DELETE', `/api/devices/${encodeURIComponent(ieee)}`),
  logs: () => call<{ entries: LogEntry[] }>('GET', '/api/logs'),
};
