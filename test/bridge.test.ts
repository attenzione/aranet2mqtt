/**
 * The whole bridge against a real (in-process) MQTT broker, with fake sensors.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Bridge } from '../src/bridge/bridge.ts';
import { deviceIeee } from '../src/bridge/ids.ts';
import { MqttLink } from '../src/bridge/mqtt.ts';
import { ConfigStore } from '../src/config.ts';
import { Logger } from '../src/log.ts';
import { FakeSource } from '../src/source/fake.ts';

const READING = { co2: 812, temperature: 22.4, humidity: 41, pressure: 1009.3, battery: 93, status: 'green' as const };

interface Harness {
  broker: Aedes;
  server: Server;
  port: number;
  dir: string;
  store: ConfigStore;
  source: FakeSource;
  bridge: Bridge;
  client: MqttClient;
  /** Latest payload per topic, as the subscriber saw it. */
  seen: Map<string, string>;
  clock: { now: number };
}

let h: Harness;

async function waitFor<T>(check: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const json = (topic: string) => waitFor(() => {
  const raw = h.seen.get(topic);
  return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
});

beforeEach(async () => {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = await mkdtemp(join(tmpdir(), 'aranet2mqtt-'));
  const store = await ConfigStore.load(join(dir, 'configuration.yaml'));
  await store.update((d) => {
    d.mqtt.host = '127.0.0.1';
    d.mqtt.port = port;
    d.mqtt.reconnect_period = 1;
    d.availability.timeout = 60;
  });
  const logger = new Logger({ quiet: true });
  const source = new FakeSource({ intervalMs: 3_600_000 });
  const clock = { now: Date.now() };
  const bridge = new Bridge({ store, source, mqtt: new MqttLink(logger), logger, version: '0.1.0', commit: 'test', now: () => clock.now, availabilityCheckMs: 50 });

  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { clientId: 'subscriber' });
  const seen = new Map<string, string>();
  client.on('message', (topic, payload) => seen.set(topic, payload.toString()));
  await client.subscribeAsync('aranet/#');

  h = { broker, server, port, dir, store, source, bridge, client, seen, clock };
  bridge.start();
});

afterEach(async () => {
  await h.bridge.stop();
  await h.client.endAsync();
  await new Promise<void>((resolve) => h.broker.close(() => resolve()));
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  await rm(h.dir, { recursive: true, force: true });
});

const sensorReading = (device: string, extra: Partial<typeof READING> = {}) => ({ device, ...READING, ...extra, at: new Date() });

describe('bridge', () => {
  it('announces itself like a Z2M instance', async () => {
    expect(await json('aranet/bridge/state')).toEqual({ state: 'online' });
    const info = await json('aranet/bridge/info');
    expect(info).toMatchObject({ coordinator: { ieee_address: h.store.bridgeIeee }, permit_join: false });
    const devices = await json('aranet/bridge/devices') as unknown as { type: string }[];
    expect(devices.map((d) => d.type)).toEqual(['Coordinator']);
  });

  it('ignores unknown sensors until joining is open, then adds and publishes them', async () => {
    await json('aranet/bridge/state');
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.seen.has('aranet/Aranet4 1A2B3')).toBe(false);
    expect(h.bridge.status().nearby.map((n) => n.name)).toEqual(['Aranet4 1A2B3']);

    // Opening joining adds what was already heard, without waiting for the next broadcast.
    h.client.publish('aranet/bridge/request/permit_join', JSON.stringify({ time: 60, transaction: 'tx1' }));
    expect(await json('aranet/bridge/response/permit_join')).toEqual({ data: { time: 60 }, status: 'ok', transaction: 'tx1' });
    expect(await json('aranet/Aranet4 1A2B3')).toMatchObject({ co2: 812, air_quality: 'excellent' });
    expect(await json('aranet/Aranet4 1A2B3/availability')).toEqual({ state: 'online' });
    const devices = await waitFor(() => {
      const list = JSON.parse(h.seen.get('aranet/bridge/devices') ?? '[]') as { ieee_address: string; friendly_name: string }[];
      return list.length === 2 ? list : undefined;
    });
    expect(devices[1]).toMatchObject({ ieee_address: deviceIeee('Aranet4 1A2B3'), friendly_name: 'Aranet4 1A2B3' });
    expect(h.store.current.devices[deviceIeee('Aranet4 1A2B3')]?.ble_name).toBe('Aranet4 1A2B3');
  });

  it('keeps every sensor that joins in the same listen', async () => {
    await json('aranet/bridge/state');
    await h.bridge.setPermitJoin(60);
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    h.source.emitReading(sensorReading('Aranet4 4C5D6'));
    h.source.emitReading(sensorReading('Aranet4 1A2B3', { co2: 820 }));
    await waitFor(() => h.bridge.status().devices.length === 2 || undefined);
    await waitFor(() => h.seen.has('aranet/Aranet4 4C5D6') || undefined);
    const reloaded = await ConfigStore.load(h.store.path);
    expect(Object.values(reloaded.current.devices).map((d) => d.ble_name).sort()).toEqual(['Aranet4 1A2B3', 'Aranet4 4C5D6']);
  });

  it('renames: moves the state and clears the old retained topics', async () => {
    await h.bridge.addDevice('Aranet4 1A2B3');
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    await json('aranet/Aranet4 1A2B3');

    h.client.publish('aranet/bridge/request/device/rename', JSON.stringify({ from: 'Aranet4 1A2B3', to: 'Bedroom' }));
    expect(await json('aranet/bridge/response/device/rename')).toMatchObject({ status: 'ok', data: { from: 'Aranet4 1A2B3', to: 'Bedroom' } });
    expect(await json('aranet/Bedroom')).toMatchObject({ co2: 812 });
    await waitFor(() => h.seen.get('aranet/Aranet4 1A2B3') === '');
  });

  it('publishes a changed reading at once and skips an unchanged one', async () => {
    await h.bridge.addDevice('Aranet4 1A2B3');
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    await json('aranet/Aranet4 1A2B3');
    let count = 0;
    h.client.on('message', (topic) => { if (topic === 'aranet/Aranet4 1A2B3') count++; });
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    h.source.emitReading(sensorReading('Aranet4 1A2B3', { co2: 900 }));
    await waitFor(() => (JSON.parse(h.seen.get('aranet/Aranet4 1A2B3')!) as { co2: number }).co2 === 900);
    expect(count).toBe(1);
  });

  it('marks a silent sensor offline after the availability timeout', async () => {
    await h.bridge.addDevice('Aranet4 1A2B3');
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    expect(await json('aranet/Aranet4 1A2B3/availability')).toEqual({ state: 'online' });
    h.clock.now += 61_000;
    await waitFor(() => h.seen.get('aranet/Aranet4 1A2B3/availability') === JSON.stringify({ state: 'offline' }));
  });

  it('republishes bridge/info when the reported Zigbee2MQTT version changes', async () => {
    expect(await json('aranet/bridge/info')).toMatchObject({ version: '2.14.2' });
    const { bluetooth, availability, log_level } = h.store.current;
    await h.bridge.applyAdvanced({ bluetooth, availability, log_level, z2m_version: '2.0.0' });
    await waitFor(() => (JSON.parse(h.seen.get('aranet/bridge/info')!) as { version: string }).version === '2.0.0' || undefined);
    expect(h.bridge.status().z2m_version).toBe('2.0.0');
  });

  it('answers unsupported requests at once with an error', async () => {
    await json('aranet/bridge/state');
    h.client.publish('aranet/bridge/request/device/ota_update/check', JSON.stringify({ id: 'x', transaction: 7 }));
    expect(await json('aranet/bridge/response/device/ota_update/check')).toMatchObject({ status: 'error', transaction: 7 });
  });

  it('removes a device and its retained topics', async () => {
    await h.bridge.addDevice('Aranet4 1A2B3', 'Kitchen');
    h.source.emitReading(sensorReading('Aranet4 1A2B3'));
    await json('aranet/Kitchen');
    h.client.publish('aranet/bridge/request/device/remove', JSON.stringify({ id: 'Kitchen' }));
    expect(await json('aranet/bridge/response/device/remove')).toMatchObject({ status: 'ok' });
    await waitFor(() => h.seen.get('aranet/Kitchen') === '');
    expect(h.store.current.devices).toEqual({});
  });

  it('matches a reading reported by address once a scan has named the sensor', async () => {
    await h.bridge.addDevice('Aranet4 1A2B3');
    h.source.discover = () => {};
    h.source.emit('sighting', { name: 'Aranet4 1A2B3', address: 'C0:FF:EE:00:00:01', rssi: null, model: 'Aranet4', at: new Date() });
    await waitFor(() => h.store.current.devices[deviceIeee('Aranet4 1A2B3')]?.address === 'C0:FF:EE:00:00:01' || undefined);
    h.source.emitReading(sensorReading('c0:ff:ee:00:00:01'));
    expect(await json('aranet/Aranet4 1A2B3')).toMatchObject({ co2: 812 });
  });

  it('leaves an offline last will when it stops', async () => {
    await json('aranet/bridge/state');
    await h.bridge.stop();
    await waitFor(() => h.seen.get('aranet/bridge/state') === JSON.stringify({ state: 'offline' }));
  });
});
