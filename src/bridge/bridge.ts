/**
 * The bridge: takes readings from the Bluetooth source and keeps the broker
 * looking like one Zigbee2MQTT instance under `<base_topic>`.
 *
 * - `bridge/state` online/offline (offline is also the last will)
 * - `bridge/info` and `bridge/devices`, retained
 * - `<friendly_name>` state and `<friendly_name>/availability`
 * - `bridge/request/*` answered on `bridge/response/*`
 */

import { EventEmitter } from 'node:events';

import { FriendlyName, UserError, type BluetoothConfig, type Config, type ConfigStore, type DeviceConfig, type MqttConfig } from '../config.ts';
import type { Level, Logger } from '../log.ts';
import type { Reading, ReadingSource, Sighting, SourceStatus } from '../source/types.ts';
import { deviceIeee, isMacAddress, modelFromName, SUPPORTED_MODELS } from './ids.ts';
import type { MqttLink, Outgoing } from './mqtt.ts';
import {
  bridgeDevices, bridgeInfo, deviceEvent, interviewEvent, measuredValues, statePayload, type JsonObject,
} from './payloads.ts';

const ONLINE = JSON.stringify({ state: 'online' });
const OFFLINE = JSON.stringify({ state: 'offline' });
const BRIDGE_TOPIC = { qos: 1, retain: true } as const;
/** An unchanged reading is published again after this long, so `last_seen` keeps moving. */
const HEARTBEAT_MS = 5 * 60_000;
const AVAILABILITY_CHECK_MS = 15_000;
const PERMIT_JOIN_MAX_S = 254;

interface Runtime {
  reading?: Reading;
  heardAt?: number;
  /** Undefined until it is known: the retained value from the last run stands meanwhile. */
  available?: boolean;
  publishedValues?: string;
  publishedAt?: number;
}

interface Nearby {
  name: string;
  address?: string;
  rssi: number | null;
  seenAt: number;
  reading?: Reading;
}

/** The web UI's Settings page. */
export interface AdvancedChange {
  bluetooth: BluetoothConfig;
  availability: Config['availability'];
  log_level: Level;
  /** The Zigbee2MQTT version reported in bridge/info. */
  z2m_version: string;
}

export interface BridgeOptions {
  store: ConfigStore;
  source: ReadingSource;
  mqtt: MqttLink;
  logger: Logger;
  version: string;
  commit: string;
  now?: () => number;
  availabilityCheckMs?: number;
}

export interface DeviceStatus {
  ieee_address: string;
  friendly_name: string;
  ble_name: string;
  address: string;
  model: string;
  available: boolean | null;
  last_seen: string | null;
  state: JsonObject | null;
}

export interface NearbyStatus {
  name: string;
  address: string | null;
  model: string;
  supported: boolean;
  rssi: number | null;
  last_seen: string;
  state: JsonObject | null;
}

export interface BridgeStatus {
  version: string;
  z2m_version: string;
  commit: string;
  ieee_address: string;
  mqtt: { configured: boolean; connected: boolean; url: string | undefined; error: string | undefined; base_topic: string };
  bluetooth: SourceStatus;
  permit_join: { active: boolean; end: number | null };
  devices: DeviceStatus[];
  nearby: NearbyStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Bridge extends EventEmitter<{ restart: [] }> {
  readonly #store: ConfigStore;
  readonly #source: ReadingSource;
  readonly #mqtt: MqttLink;
  readonly #logger: Logger;
  readonly #version: string;
  readonly #commit: string;
  readonly #now: () => number;
  readonly #availabilityCheckMs: number;
  readonly #runtime = new Map<string, Runtime>();
  readonly #nearby = new Map<string, Nearby>();
  readonly #nameByAddress = new Map<string, string>();
  #startedAt = 0;
  #permitJoinEnd?: number;
  #permitJoinTimer?: NodeJS.Timeout;
  #availabilityTimer?: NodeJS.Timeout;
  #lastJoined?: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeOptions) {
    super();
    this.#store = options.store;
    this.#source = options.source;
    this.#mqtt = options.mqtt;
    this.#logger = options.logger;
    this.#version = options.version;
    this.#commit = options.commit;
    this.#now = options.now ?? Date.now;
    this.#availabilityCheckMs = options.availabilityCheckMs ?? AVAILABILITY_CHECK_MS;
  }

  get #config(): Config {
    return this.#store.current;
  }

  get base(): string {
    return this.#config.mqtt.base_topic;
  }

  start(): void {
    this.#startedAt = this.#now();
    this.#mqtt.on('connect', () => this.#guard('announcing on connect', () => this.#onConnect()));
    this.#mqtt.on('message', (topic, payload) => this.#guard(`handling ${topic}`, () => this.#onMessage(topic, payload)));
    this.#source.on('reading', (reading) => this.#guard('handling a reading', () => this.#onReading(reading)));
    this.#source.on('sighting', (sighting) => this.#guard('handling a sighting', () => this.#onSighting(sighting)));
    this.#startMqtt();
    this.#source.start();
    this.#availabilityTimer = setInterval(() => this.#guard('checking availability', () => this.#checkAvailability()), this.#availabilityCheckMs);
    this.#availabilityTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#availabilityTimer);
    clearTimeout(this.#permitJoinTimer);
    await this.#source.stop();
    await this.#mqtt.stop([[`${this.base}/bridge/state`, OFFLINE, BRIDGE_TOPIC]]);
  }

  // --- State for the web UI ----------------------------------------------------

  status(): BridgeStatus {
    const { mqtt, devices } = this.#config;
    const known = new Set(Object.values(devices).map((d) => d.ble_name));
    return {
      version: this.#version,
      z2m_version: this.#config.bridge.version,
      commit: this.#commit,
      ieee_address: this.#store.bridgeIeee,
      mqtt: {
        configured: this.#mqtt.configured,
        connected: this.#mqtt.connected,
        url: this.#mqtt.url,
        error: this.#mqtt.error,
        base_topic: mqtt.base_topic,
      },
      bluetooth: this.#source.status,
      permit_join: { active: this.#permitJoinEnd !== undefined, end: this.#permitJoinEnd ?? null },
      devices: Object.entries(devices).map(([ieee, d]): DeviceStatus => {
        const rt = this.#runtime.get(ieee);
        return {
          ieee_address: ieee,
          friendly_name: d.friendly_name,
          ble_name: d.ble_name,
          address: d.address,
          model: d.model,
          available: rt?.available ?? null,
          last_seen: rt?.heardAt ? new Date(rt.heardAt).toISOString() : null,
          state: rt?.reading ? measuredValues(rt.reading) : null,
        };
      }),
      nearby: [...this.#nearby.values()]
        .filter((n) => !known.has(n.name))
        .map((n): NearbyStatus => ({
          name: n.name,
          address: n.address ?? null,
          model: modelFromName(n.name),
          supported: SUPPORTED_MODELS.has(modelFromName(n.name)),
          rssi: n.rssi,
          last_seen: new Date(n.seenAt).toISOString(),
          state: n.reading ? measuredValues(n.reading) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // --- Actions (web UI and bridge requests) --------------------------------------

  /** Add, rename, remove and settings changes run one at a time, so none acts on a stale device list. */
  addDevice(bleName: string, friendlyName?: string): Promise<[string, DeviceConfig]> {
    return this.#exclusive(() => this.#addDevice(bleName, friendlyName));
  }

  renameDevice(idOrName: string, to: string): Promise<{ from: string; to: string }> {
    return this.#exclusive(() => this.#renameDevice(idOrName, to));
  }

  removeDevice(idOrName: string): Promise<{ id: string; ieee: string }> {
    return this.#exclusive(() => this.#removeDevice(idOrName));
  }

  async #addDevice(bleName: string, friendlyName?: string): Promise<[string, DeviceConfig]> {
    if (isMacAddress(bleName)) throw new UserError('Wait until the sensor\'s Bluetooth name is known, then add it');
    const model = modelFromName(bleName);
    if (!SUPPORTED_MODELS.has(model)) throw new UserError(`${model} is not supported yet; only Aranet4 is`);
    const ieee = deviceIeee(bleName);
    const existing = this.#config.devices[ieee];
    if (existing) return [ieee, existing];

    const name = this.#checkName(friendlyName?.trim() || bleName, ieee);
    const nearby = this.#nearby.get(bleName);
    await this.#store.update((draft) => {
      draft.devices[ieee] = { friendly_name: name, ble_name: bleName, address: nearby?.address ?? '', model };
    });
    const device = this.#config.devices[ieee]!;
    this.#lastJoined = ieee;
    this.#logger.info(`Added ${bleName} as "${name}" (${ieee})`);

    await this.#publishBridge('event', deviceEvent('device_joined', ieee, name));
    await this.#publishBridge('event', interviewEvent(ieee, device));
    await this.#publishDevices();
    await this.#publishInfo();

    // It was heard before it was added: publish what it said.
    if (nearby?.reading) {
      const rt = this.#rt(ieee);
      rt.reading = nearby.reading;
      rt.heardAt = nearby.seenAt;
      rt.available = true;
      await this.#publishAvailability(device, true);
      await this.#publishState(device, rt, true);
    }
    return [ieee, device];
  }

  async #renameDevice(idOrName: string, to: string): Promise<{ from: string; to: string }> {
    const [ieee, device] = this.#resolve(idOrName);
    const name = this.#checkName(to, ieee);
    const from = device.friendly_name;
    if (name === from) return { from, to: name };
    await this.#store.update((draft) => {
      draft.devices[ieee]!.friendly_name = name;
    });
    this.#logger.info(`Renamed "${from}" to "${name}"`);
    await this.#clearDeviceTopics(this.base, from);
    await this.#publishDevices();
    await this.#publishInfo();
    const renamed = this.#config.devices[ieee]!;
    const rt = this.#runtime.get(ieee);
    if (rt?.available !== undefined) await this.#publishAvailability(renamed, rt.available);
    if (rt?.reading) await this.#publishState(renamed, rt, true);
    return { from, to: name };
  }

  async #removeDevice(idOrName: string): Promise<{ id: string; ieee: string }> {
    const [ieee, device] = this.#resolve(idOrName);
    await this.#store.update((draft) => {
      delete draft.devices[ieee];
    });
    this.#runtime.delete(ieee);
    this.#logger.info(`Removed "${device.friendly_name}" (${ieee})`);
    await this.#clearDeviceTopics(this.base, device.friendly_name);
    await this.#publishBridge('event', deviceEvent('device_leave', ieee, device.friendly_name));
    await this.#publishDevices();
    await this.#publishInfo();
    return { id: idOrName, ieee };
  }

  /** Opens joining for `seconds` (0 closes it). Sensors heard while it is open are added. */
  async setPermitJoin(seconds: number): Promise<number> {
    const time = Math.max(0, Math.min(PERMIT_JOIN_MAX_S, Math.round(seconds)));
    clearTimeout(this.#permitJoinTimer);
    if (time > 0) {
      this.#permitJoinEnd = this.#now() + time * 1000;
      this.#permitJoinTimer = setTimeout(() => this.#guard('closing joining', async () => {
        await this.setPermitJoin(0);
      }), time * 1000);
      this.#permitJoinTimer.unref();
      this.#logger.info(`Joining open for ${time} s: sensors heard now are added`);
    } else if (this.#permitJoinEnd !== undefined) {
      this.#permitJoinEnd = undefined;
      this.#logger.info('Joining closed');
    }
    await this.#publishInfo();
    if (time > 0) {
      // Sensors already heard don't need to wait for the next broadcast.
      for (const n of this.#nearby.values()) {
        if (n.reading && this.#joinable(n.name)) await this.addDevice(n.name);
      }
      this.#source.discover();
    }
    return time;
  }

  applyMqtt(next: MqttConfig): Promise<void> {
    return this.#exclusive(() => this.#applyMqtt(next));
  }

  async #applyMqtt(next: MqttConfig): Promise<void> {
    const oldBase = this.base;
    const oldDevices = Object.values(this.#config.devices).map((d) => d.friendly_name);
    await this.#store.update((draft) => {
      draft.mqtt = next;
    });
    const final: Outgoing[] = [];
    if (oldBase !== next.base_topic) {
      // Leave nothing behind under the old base topic, or clients would still find a bridge there.
      for (const topic of ['bridge/state', 'bridge/info', 'bridge/devices']) final.push([`${oldBase}/${topic}`, '', BRIDGE_TOPIC]);
      for (const name of oldDevices) {
        final.push([`${oldBase}/${name}`, '', BRIDGE_TOPIC], [`${oldBase}/${name}/availability`, '', BRIDGE_TOPIC]);
      }
    } else {
      final.push([`${oldBase}/bridge/state`, OFFLINE, BRIDGE_TOPIC]);
    }
    this.#logger.info('MQTT settings saved; reconnecting');
    await this.#mqtt.stop(final);
    for (const rt of this.#runtime.values()) rt.publishedValues = undefined;
    this.#startMqtt();
  }

  applyAdvanced(change: AdvancedChange): Promise<void> {
    return this.#exclusive(() => this.#applyAdvanced(change));
  }

  async #applyAdvanced(change: AdvancedChange): Promise<void> {
    await this.#store.update((draft) => {
      draft.bluetooth = change.bluetooth;
      draft.availability = change.availability;
      draft.log_level = change.log_level;
      draft.bridge.version = change.z2m_version;
    });
    this.#logger.level = change.log_level;
    const { scan_interval, listen_duration, discovery_interval } = change.bluetooth;
    this.#source.reconfigure({ scanInterval: scan_interval, listenDuration: listen_duration, discoveryInterval: discovery_interval });
    await this.#publishInfo();
    await this.#checkAvailability();
  }

  discover(): void {
    this.#source.discover();
  }

  // --- Events ---------------------------------------------------------------------

  async #onConnect(): Promise<void> {
    const base = this.base;
    await this.#mqtt.subscribe([`${base}/bridge/request/#`]);
    await this.#mqtt.publish(`${base}/bridge/state`, ONLINE, BRIDGE_TOPIC);
    await this.#publishInfo();
    await this.#publishDevices();
    for (const [ieee, device] of Object.entries(this.#config.devices)) {
      const rt = this.#runtime.get(ieee);
      if (rt?.available !== undefined) await this.#publishAvailability(device, rt.available);
      if (rt?.reading) await this.#publishState(device, rt, true);
    }
  }

  async #onReading(reading: Reading): Promise<void> {
    const name = isMacAddress(reading.device)
      ? this.#nameByAddress.get(reading.device.toUpperCase()) ?? reading.device.toUpperCase()
      : reading.device;
    const nearby = this.#nearby.get(name) ?? { name, rssi: null, seenAt: 0 };
    nearby.reading = reading;
    nearby.seenAt = this.#now();
    this.#nearby.set(name, nearby);

    let ieee = deviceIeee(name);
    let device = this.#config.devices[ieee];
    if (!device && this.#joinable(name)) [ieee, device] = await this.addDevice(name);
    if (!device) return;

    const rt = this.#rt(ieee);
    rt.reading = reading;
    rt.heardAt = this.#now();
    if (rt.available !== true) {
      if (rt.available === false) this.#logger.info(`"${device.friendly_name}" is back online`);
      rt.available = true;
      await this.#publishAvailability(device, true);
    }
    await this.#publishState(device, rt, false);
  }

  async #onSighting(sighting: Sighting): Promise<void> {
    if (!sighting.name) return;
    this.#nameByAddress.set(sighting.address, sighting.name);
    const nearby = this.#nearby.get(sighting.name) ?? { name: sighting.name, rssi: null, seenAt: 0 };
    nearby.address = sighting.address;
    nearby.rssi = sighting.rssi;
    nearby.seenAt = Math.max(nearby.seenAt, sighting.at.getTime());
    this.#nearby.set(sighting.name, nearby);

    const ieee = deviceIeee(sighting.name);
    const device = this.#config.devices[ieee];
    if (device && device.address !== sighting.address) {
      await this.#exclusive(async () => {
        if (!this.#config.devices[ieee]) return;
        await this.#store.update((draft) => {
          draft.devices[ieee]!.address = sighting.address;
        });
        await this.#publishDevices();
      });
    }
  }

  async #checkAvailability(): Promise<void> {
    const timeoutMs = this.#config.availability.timeout * 1000;
    const now = this.#now();
    for (const [ieee, device] of Object.entries(this.#config.devices)) {
      const rt = this.#rt(ieee);
      const last = rt.heardAt ?? this.#startedAt;
      const available = now - last <= timeoutMs;
      if (available || rt.available === false) continue;
      rt.available = false;
      this.#logger.warn(`"${device.friendly_name}" not heard for ${Math.round((now - last) / 60_000)} min; offline`);
      await this.#publishAvailability(device, false);
    }
  }

  async #onMessage(topic: string, payload: Buffer): Promise<void> {
    const prefix = `${this.base}/bridge/request/`;
    if (!topic.startsWith(prefix)) return;
    const path = topic.slice(prefix.length);
    const text = payload.toString();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const response: JsonObject = {};
    try {
      response.data = await this.#handleRequest(path, body);
      response.status = 'ok';
    } catch (err) {
      response.data = {};
      response.status = 'error';
      response.error = err instanceof Error ? err.message : String(err);
      this.#logger.info(`Request ${path} failed: ${response.error}`);
    }
    if (isRecord(body) && (typeof body.transaction === 'string' || typeof body.transaction === 'number')) {
      response.transaction = body.transaction;
    }
    await this.#mqtt.publish(`${this.base}/bridge/response/${path}`, JSON.stringify(response), { qos: 1, retain: false });
  }

  async #handleRequest(path: string, body: unknown): Promise<JsonObject> {
    const fields = isRecord(body) ? body : {};
    switch (path) {
      case 'permit_join': {
        const value = isRecord(body) ? (body.time ?? body.value) : body;
        let seconds: number;
        if (typeof value === 'boolean') seconds = value ? PERMIT_JOIN_MAX_S : 0;
        else if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))) seconds = Number(value);
        else throw new Error('Expected {"time": <seconds>}');
        return { time: await this.setPermitJoin(seconds) };
      }
      case 'health_check':
        return { healthy: true };
      case 'device/rename': {
        const from = fields.last === true ? this.#lastJoined : fields.from;
        if (typeof from !== 'string' || typeof fields.to !== 'string') throw new Error('Expected {"from": <name or address>, "to": <new name>}');
        const result = await this.renameDevice(from, fields.to);
        return { ...result, homeassistant_rename: false };
      }
      case 'device/remove': {
        const id = typeof body === 'string' ? body : fields.id;
        if (typeof id !== 'string') throw new Error('Expected {"id": <name or address>}');
        await this.removeDevice(id);
        return { id, block: false, force: fields.force === true };
      }
      case 'restart':
        setTimeout(() => this.emit('restart'), 500).unref();
        return {};
      default:
        throw new Error(`Request '${path}' is not supported by aranet2mqtt`);
    }
  }

  // --- Publishing -------------------------------------------------------------------

  #startMqtt(): void {
    this.#mqtt.start(this.#config.mqtt, { topic: `${this.base}/bridge/state`, payload: OFFLINE });
  }

  async #publishInfo(): Promise<void> {
    await this.#publishBridge('info', bridgeInfo({
      version: this.#version, commit: this.#commit, config: this.#config, permitJoinEnd: this.#permitJoinEnd,
    }), true);
  }

  async #publishDevices(): Promise<void> {
    await this.#publishBridge('devices', bridgeDevices(this.#store.bridgeIeee, this.#config.devices), true);
  }

  async #publishBridge(topic: string, payload: JsonObject | JsonObject[], retain = false): Promise<void> {
    await this.#mqtt.publish(`${this.base}/bridge/${topic}`, JSON.stringify(payload), { qos: 1, retain });
  }

  async #publishAvailability(device: DeviceConfig, available: boolean): Promise<void> {
    await this.#mqtt.publish(`${this.base}/${device.friendly_name}/availability`, available ? ONLINE : OFFLINE, BRIDGE_TOPIC);
  }

  async #publishState(device: DeviceConfig, rt: Runtime, force: boolean): Promise<void> {
    if (!rt.reading) return;
    const values = JSON.stringify(measuredValues(rt.reading));
    const now = this.#now();
    if (!force && values === rt.publishedValues && now - (rt.publishedAt ?? 0) < HEARTBEAT_MS) return;
    const { qos, retain } = this.#config.mqtt;
    const payload = JSON.stringify(statePayload(rt.reading, new Date(rt.heardAt ?? now)));
    if (await this.#mqtt.publish(`${this.base}/${device.friendly_name}`, payload, { qos, retain })) {
      rt.publishedValues = values;
      rt.publishedAt = now;
    }
  }

  /** An empty retained message deletes the retained one. */
  async #clearDeviceTopics(base: string, name: string): Promise<void> {
    await this.#mqtt.publish(`${base}/${name}`, '', BRIDGE_TOPIC);
    await this.#mqtt.publish(`${base}/${name}/availability`, '', BRIDGE_TOPIC);
  }

  // --- Helpers ------------------------------------------------------------------------

  #rt(ieee: string): Runtime {
    let rt = this.#runtime.get(ieee);
    if (!rt) {
      rt = {};
      this.#runtime.set(ieee, rt);
    }
    return rt;
  }

  #joinable(bleName: string): boolean {
    return this.#permitJoinEnd !== undefined && !isMacAddress(bleName) && SUPPORTED_MODELS.has(modelFromName(bleName))
      && !this.#config.devices[deviceIeee(bleName)];
  }

  #resolve(idOrName: string): [string, DeviceConfig] {
    const devices = this.#config.devices;
    const byIeee = devices[idOrName];
    if (byIeee) return [idOrName, byIeee];
    const entry = Object.entries(devices).find(([, d]) => d.friendly_name === idOrName || d.ble_name === idOrName);
    if (!entry) throw new UserError(`No device "${idOrName}"`);
    return entry;
  }

  #checkName(name: string, ieee: string): string {
    const parsed = FriendlyName.safeParse(name);
    if (!parsed.success) throw new UserError(`Friendly name ${parsed.error.issues[0]?.message ?? 'is not valid'}`);
    const taken = Object.entries(this.#config.devices).some(([other, d]) => other !== ieee && d.friendly_name === parsed.data);
    if (taken) throw new UserError(`Another device is already called "${parsed.data}"`);
    return parsed.data;
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  #guard(what: string, task: () => Promise<void>): void {
    task().catch((err: unknown) => this.#logger.error(`Failed ${what}:`, err));
  }
}
