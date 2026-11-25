import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config.ts';
import { deviceIeee } from '../src/bridge/ids.ts';
import { AIR_QUALITY, ARANET4_EXPOSES, bridgeDevices, bridgeInfo, statePayload } from '../src/bridge/payloads.ts';

const coordinator = '0x0123456789abcdef';
const ieee = deviceIeee('Aranet4 1A2B3');
const config = ConfigSchema.parse({
  mqtt: { host: 'broker', password: 'secret', tls: { key: 'PRIVATE KEY' } },
  bridge: { ieee_address: coordinator },
  devices: { [ieee]: { friendly_name: 'Bedroom CO2', ble_name: 'Aranet4 1A2B3', address: 'C0:FF:EE:00:00:01' } },
});

describe('device addresses', () => {
  it('are stable and Z2M-shaped', () => {
    expect(deviceIeee('Aranet4 1A2B3')).toBe(ieee);
    expect(ieee).toMatch(/^0x[0-9a-f]{16}$/);
    expect(deviceIeee('Aranet4 4C5D6')).not.toBe(ieee);
  });
});

describe('bridge/info', () => {
  const info = bridgeInfo({ version: '0.1.0', commit: 'e6410de', config, permitJoinEnd: undefined });

  it('never contains the broker password or TLS key', () => {
    const text = JSON.stringify(info);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('PRIVATE KEY');
  });

  it('reports a Zigbee2MQTT version, and its own as the coordinator revision', () => {
    expect(info.version).toBe('2.14.2');
    expect(info).toMatchObject({ coordinator: { type: 'aranet2mqtt', meta: { revision: '0.1.0', aranet_cli_commit: 'e6410de' } } });
    const custom = ConfigSchema.parse({ ...config, bridge: { ...config.bridge, version: '2.0.0' } });
    expect(bridgeInfo({ version: '0.1.0', commit: 'x', config: custom, permitJoinEnd: undefined }).version).toBe('2.0.0');
  });

  it('accepts only version numbers as the reported version', () => {
    expect(ConfigSchema.safeParse({ bridge: { version: 'latest' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ bridge: { version: '2.14.2-dev' } }).success).toBe(true);
  });

  it('says availability is published, and who the coordinator is', () => {
    expect(info).toMatchObject({
      coordinator: { ieee_address: coordinator },
      permit_join: false,
      config: { availability: { enabled: true }, mqtt: { base_topic: 'aranet' } },
    });
  });
});

describe('air quality', () => {
  const at = new Date(0);
  const level = (status: 'green' | 'yellow' | 'red' | 'error' | 'unknown') =>
    statePayload({ device: 'x', co2: 500, temperature: 20, humidity: 40, pressure: 1000, battery: 90, status, at }, at).air_quality;

  it('maps the traffic light onto Z2M\'s ladder, from the good end', () => {
    expect([level('green'), level('yellow'), level('red')]).toEqual(['excellent', 'moderate', 'poor']);
  });

  it('sends unknown when the sensor reports no valid reading', () => {
    expect([level('error'), level('unknown')]).toEqual(['unknown', 'unknown']);
  });

  it('only sends values its expose lists', () => {
    const expose = ARANET4_EXPOSES.find((e) => e.name === 'air_quality')!;
    expect(expose).toMatchObject({ type: 'enum', property: 'air_quality', access: 1 });
    for (const value of Object.values(AIR_QUALITY)) expect(expose.values).toContain(value);
  });
});

describe('state', () => {
  it('rounds float noise and uses Z2M property names', () => {
    const payload = statePayload({
      device: 'Aranet4 1A2B3', co2: 812, temperature: 22.399999618530273, humidity: 41, pressure: 1009.2999877929688,
      battery: 93, status: 'green', at: new Date(0),
    }, new Date('2026-11-25T20:00:00Z'));
    expect(payload).toEqual({
      co2: 812, temperature: 22.4, humidity: 41, pressure: 1009.3, air_quality: 'excellent', battery: 93, last_seen: '2026-11-25T20:00:00.000Z',
    });
  });
});

/**
 * The Homey app is the client these messages are built for: its own parsers
 * must accept them. Runs only where ../homey-z2m is checked out.
 */
const homeyZ2m = new URL('../../homey-z2m/lib/z2m/guards.ts', import.meta.url);

describe.runIf(existsSync(homeyZ2m))('homey-z2m accepts the bridge topics', () => {
  it('parses bridge/info and bridge/devices without warnings', async () => {
    const guards = await import(homeyZ2m.href) as {
      parseBridgeInfo: (v: unknown) => { coordinator: { ieee_address: string }; availability: { enabled: boolean } };
      parseDevices: (v: unknown, warn: (m: string) => void) => { ieee_address: string; type: string; interview_state: string; definition?: { exposes: { name?: string }[] } }[];
    };
    const warnings: string[] = [];
    const info = guards.parseBridgeInfo(JSON.parse(JSON.stringify(bridgeInfo({ version: '0.1.0', commit: 'x', config, permitJoinEnd: Date.now() + 60_000 }))));
    const devices = guards.parseDevices(JSON.parse(JSON.stringify(bridgeDevices(coordinator, config.devices))), (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect(info.coordinator.ieee_address).toBe(coordinator);
    expect(info.availability.enabled).toBe(true);
    expect(devices.map((d) => d.type)).toEqual(['Coordinator', 'EndDevice']);
    const sensor = devices[1]!;
    expect(sensor.interview_state).toBe('SUCCESSFUL');
    expect(sensor.definition?.exposes.map((e) => e.name)).toEqual(['co2', 'temperature', 'humidity', 'pressure', 'air_quality', 'battery']);
  });

  const names = new URL('../../homey-z2m/lib/mapping/names.ts', import.meta.url);
  it.runIf(existsSync(names))('maps air_quality onto Homey\'s air quality level', async () => {
    const { enumByName } = await import(names.href) as {
      enumByName: (name: string, values: readonly (string | number)[]) => { capability: string; map: Record<string, string>; values: { id: string }[] } | undefined;
    };
    const expose = ARANET4_EXPOSES.find((e) => e.name === 'air_quality')!;
    const target = enumByName('air_quality', expose.values as string[]);
    expect(target?.capability).toBe('level_aqi');
    expect(target?.values.map((v) => v.id)).toEqual(['good', 'moderate', 'poor']);
    expect(target?.map).toEqual({ excellent: 'good', moderate: 'moderate', poor: 'poor' });
  });
});
