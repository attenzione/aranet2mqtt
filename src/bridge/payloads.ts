/**
 * The Zigbee2MQTT-shaped messages: `bridge/info`, `bridge/devices`,
 * `bridge/event` and each sensor's state. Field names and shapes follow Z2M
 * 2.x, so a Z2M client (homey-z2m, Home Assistant's Z2M parsing, Node-RED)
 * reads them as one more Z2M instance.
 */

import type { Config, DeviceConfig } from '../config.ts';
import { brokerUrl } from './mqtt.ts';
import type { AranetStatus, Reading } from '../source/types.ts';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

const READ = 1; // access bit: published in the state

/** Exposes of an Aranet4, named as Z2M names the same measurements on Zigbee sensors. */
export const ARANET4_EXPOSES: JsonObject[] = [
  { type: 'numeric', name: 'co2', property: 'co2', label: 'CO2', access: READ, unit: 'ppm', description: 'The measured CO2 (carbon dioxide) value' },
  { type: 'numeric', name: 'temperature', property: 'temperature', label: 'Temperature', access: READ, unit: '°C', description: 'Measured temperature value' },
  { type: 'numeric', name: 'humidity', property: 'humidity', label: 'Humidity', access: READ, unit: '%', description: 'Measured relative humidity' },
  { type: 'numeric', name: 'pressure', property: 'pressure', label: 'Pressure', access: READ, unit: 'hPa', description: 'The measured atmospheric pressure' },
  // Z2M's air quality level: the ladder's words, from the good end, as for its
  // three-step CO2 devices (homey-z2m docs/air-quality.md). Not a name of our own.
  {
    type: 'enum', name: 'air_quality', property: 'air_quality', label: 'Air quality', access: READ,
    values: ['excellent', 'moderate', 'poor', 'unknown'], description: 'Measured air quality',
  },
  {
    type: 'numeric', name: 'battery', property: 'battery', label: 'Battery', access: READ, unit: '%',
    value_min: 0, value_max: 100, category: 'diagnostic', description: 'Remaining battery in %',
  },
];

const MODELS: Record<string, { description: string; exposes: JsonObject[] }> = {
  Aranet4: { description: 'Aranet4 CO2, temperature, humidity and pressure monitor', exposes: ARANET4_EXPOSES },
};

export function definitionFor(model: string): JsonObject | null {
  const m = MODELS[model];
  if (!m) return null;
  return {
    model,
    vendor: 'SAF Tehnika',
    description: m.description,
    source: 'external',
    supports_ota: false,
    exposes: m.exposes,
    options: [],
  };
}

/** Z2M 2.x sends `interview_state`, plus the two flags it deprecated, for older clients. */
const INTERVIEWED = { interview_state: 'SUCCESSFUL', interview_completed: true, interviewing: false } as const;

const NO_CLUSTERS: JsonObject = { bindings: [], configured_reportings: [], clusters: { input: [], output: [] }, scenes: [] };

export function deviceEntry(ieee: string, device: DeviceConfig): JsonObject {
  const definition = definitionFor(device.model);
  return {
    ieee_address: ieee,
    type: 'EndDevice',
    network_address: Number.parseInt(ieee.slice(-4), 16),
    friendly_name: device.friendly_name,
    description: device.address ? `Bluetooth ${device.ble_name} (${device.address})` : `Bluetooth ${device.ble_name}`,
    supported: definition !== null,
    disabled: false,
    ...INTERVIEWED,
    power_source: 'Battery',
    manufacturer: 'SAF Tehnika',
    model_id: device.model,
    software_build_id: null,
    date_code: null,
    endpoints: { 1: NO_CLUSTERS },
    definition,
  };
}

export function bridgeDevices(coordinatorIeee: string, devices: Config['devices']): JsonObject[] {
  return [
    {
      ieee_address: coordinatorIeee,
      type: 'Coordinator',
      network_address: 0,
      friendly_name: 'Coordinator',
      supported: true,
      disabled: false,
      ...INTERVIEWED,
      endpoints: { 1: NO_CLUSTERS },
      definition: null,
    },
    ...Object.entries(devices).map(([ieee, device]) => deviceEntry(ieee, device)),
  ];
}

export interface InfoInput {
  /** aranet2mqtt's own version. */
  version: string;
  /** The upstream aranet CLI's commit. */
  commit: string;
  config: Config;
  permitJoinEnd: number | undefined;
}

/**
 * `bridge/info`. Clients read `version` as the Zigbee2MQTT version (some
 * require a minimum), so it is the configured Z2M version; aranet2mqtt's own
 * goes in `coordinator.meta.revision`, where Z2M puts the coordinator's
 * firmware revision. Clients read `coordinator.ieee_address` as the bridge's
 * identity and `config.availability` to know that `<name>/availability` is
 * published. The broker password and TLS material are never included.
 */
export function bridgeInfo({ version, commit, config, permitJoinEnd }: InfoInput): JsonObject {
  const { mqtt, availability, devices, log_level } = config;
  const minutes = Math.max(1, Math.round(availability.timeout / 60));
  return {
    version: config.bridge.version,
    commit,
    coordinator: {
      ieee_address: config.bridge.ieee_address ?? '',
      type: 'aranet2mqtt',
      meta: { product: 'aranet2mqtt', revision: version, transport: 'bluetooth-passive', aranet_cli_commit: commit },
    },
    permit_join: permitJoinEnd !== undefined,
    ...(permitJoinEnd !== undefined ? { permit_join_end: permitJoinEnd } : {}),
    restart_required: false,
    log_level,
    config: {
      mqtt: { base_topic: mqtt.base_topic, server: brokerUrl(mqtt), client_id: mqtt.client_id, version: mqtt.version },
      availability: { enabled: true, active: { timeout: minutes }, passive: { timeout: minutes } },
      advanced: { last_seen: 'ISO_8601', log_level },
      devices: Object.fromEntries(Object.entries(devices).map(([ieee, d]) => [ieee, { friendly_name: d.friendly_name }])),
    },
    config_schema: {},
  };
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/**
 * The sensor's CO2 traffic light as Z2M's `air_quality`. The thresholds stay
 * the sensor's own (by default 1000 and 1400 ppm). Its "error" status means
 * there is no valid reading.
 */
export const AIR_QUALITY: Record<AranetStatus, string> = {
  green: 'excellent',
  yellow: 'moderate',
  red: 'poor',
  error: 'unknown',
  unknown: 'unknown',
};

/** The measured values only; compared to decide whether a new reading is worth publishing. */
export function measuredValues(reading: Reading): JsonObject {
  return {
    co2: reading.co2,
    temperature: round(reading.temperature, 2),
    humidity: round(reading.humidity, 1),
    pressure: round(reading.pressure, 1),
    air_quality: AIR_QUALITY[reading.status],
    battery: reading.battery,
  };
}

/** `<base>/<friendly_name>`. */
export function statePayload(reading: Reading, lastSeen: Date): JsonObject {
  return { ...measuredValues(reading), last_seen: lastSeen.toISOString() };
}

export function deviceEvent(type: 'device_joined' | 'device_leave', ieee: string, friendlyName: string): JsonObject {
  return { type, data: { friendly_name: friendlyName, ieee_address: ieee } };
}

export function interviewEvent(ieee: string, device: DeviceConfig): JsonObject {
  const definition = definitionFor(device.model);
  return {
    type: 'device_interview',
    data: {
      friendly_name: device.friendly_name,
      ieee_address: ieee,
      status: 'successful',
      supported: definition !== null,
      definition,
    },
  };
}
