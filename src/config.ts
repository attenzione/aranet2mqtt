/**
 * configuration.yaml: everything the web UI edits, in one file like
 * Zigbee2MQTT's own. Written atomically with mode 0600, because it holds the
 * broker password and TLS key.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { randomIeee } from './bridge/ids.ts';
import { LEVELS } from './log.ts';

/** `+` and `#` are MQTT wildcards; a leading or trailing `/` makes an empty level. */
const topicLevels = (value: string) => !/[+#]/.test(value) && !value.startsWith('/') && !value.endsWith('/') && !value.includes('//');

export const IEEE = /^0x[0-9a-f]{16}$/;

/**
 * The Zigbee2MQTT version reported in `bridge/info`. Clients read it as the
 * Z2M version, and some require a minimum, so it is a real Z2M release whose
 * message shapes aranet2mqtt follows: the release it was last checked against.
 */
export const DEFAULT_Z2M_VERSION = '2.14.2';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const MqttSchema = z.object({
  protocol: z.enum(['mqtt', 'mqtts', 'ws', 'wss']).default('mqtt'),
  host: z.string().trim().default(''),
  port: z.number().int().min(1).max(65535).default(1883),
  /** WebSocket path; used only with ws and wss. */
  path: z.string().trim().default('/mqtt'),
  username: z.string().default(''),
  password: z.string().default(''),
  client_id: z.string().trim().min(1).max(128).default('aranet2mqtt'),
  base_topic: z.string().trim().min(1).refine(topicLevels, 'must not contain + or #, or start or end with /').default('aranet'),
  /** 3 = MQTT 3.1, 4 = 3.1.1, 5 = 5.0. */
  version: z.union([z.literal(3), z.literal(4), z.literal(5)]).default(4),
  keepalive: z.number().int().min(0).max(65535).default(60),
  clean: z.boolean().default(true),
  /** Seconds. */
  connect_timeout: z.number().int().min(1).max(300).default(30),
  /** Seconds between reconnect attempts. */
  reconnect_period: z.number().int().min(1).max(3600).default(5),
  /** For device state messages; bridge topics are always QoS 1, retained. */
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  retain: z.boolean().default(true),
  tls: z.object({
    /** PEM text, not file paths: pasted into the web UI. */
    ca: z.string().default(''),
    cert: z.string().default(''),
    key: z.string().default(''),
    reject_unauthorized: z.boolean().default(true),
  }).prefault({}),
});

export const BluetoothSchema = z.object({
  /** Seconds between passive listens (`aranet watch -i`). */
  scan_interval: z.number().int().min(5).max(3600).default(30),
  /** Seconds each passive listen lasts (`aranet watch -T`). */
  listen_duration: z.number().int().min(3).max(120).default(10),
  /** Seconds between `aranet scan` runs, which learn the sensors' addresses. */
  discovery_interval: z.number().int().min(60).max(86400).default(600),
});

export const AvailabilitySchema = z.object({
  /** Seconds without a broadcast before a sensor is reported offline. */
  timeout: z.number().int().min(60).max(86400).default(900),
});

/** Z2M's own rules for friendly names, minus the ones about groups. */
export const FriendlyName = z.string().trim().min(1).max(100)
  .refine(topicLevels, 'must not contain + or #, or start or end with /')
  .refine((v) => v !== 'bridge' && !v.startsWith('bridge/'), 'must not be "bridge"')
  .refine((v) => !/\/\d+$/.test(v), 'must not end with /<number>')
  .refine((v) => !/\/(set|get|availability)$/.test(v), 'must not end with /set, /get or /availability');

export const DeviceSchema = z.object({
  friendly_name: FriendlyName,
  /** The Bluetooth name, e.g. "Aranet4 1A2B3". It holds the serial, so it is the identity. */
  ble_name: z.string().min(1),
  /** Learned from `aranet scan`; informational. */
  address: z.string().default(''),
  model: z.string().default('Aranet4'),
});

export const ConfigSchema = z.object({
  mqtt: MqttSchema.prefault({}),
  bluetooth: BluetoothSchema.prefault({}),
  availability: AvailabilitySchema.prefault({}),
  bridge: z.object({
    /** The fake coordinator's address: the bridge's identity on the broker. Generated once. */
    ieee_address: z.string().regex(IEEE).optional(),
    /** Reported as the Zigbee2MQTT version in `bridge/info`. */
    version: z.string().trim().regex(SEMVER, 'must be a version like 2.14.2').default(DEFAULT_Z2M_VERSION),
  }).prefault({}),
  devices: z.record(z.string().regex(IEEE), DeviceSchema).default({}),
  log_level: z.enum(LEVELS).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MqttConfig = z.infer<typeof MqttSchema>;
export type BluetoothConfig = z.infer<typeof BluetoothSchema>;
export type DeviceConfig = z.infer<typeof DeviceSchema>;

/** A message for the person at the web UI. */
export class UserError extends Error {
  override name = 'UserError';
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
}

const HEADER = '# aranet2mqtt configuration. Edited by its web UI; changes made here while it runs are overwritten.\n';

export class ConfigStore {
  readonly path: string;
  #config: Config;
  #writing: Promise<void> = Promise.resolve();

  private constructor(path: string, config: Config) {
    this.path = path;
    this.#config = config;
  }

  /** Reads the file (or starts from defaults) and makes sure the bridge has an identity. */
  static async load(path: string): Promise<ConfigStore> {
    let raw: unknown = {};
    try {
      raw = parse(await readFile(path, 'utf8')) ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) throw new Error(`${path} is not valid: ${describeIssues(result.error)}`);
    const store = new ConfigStore(path, result.data);
    if (!result.data.bridge.ieee_address) {
      await store.update((draft) => {
        draft.bridge.ieee_address = randomIeee();
      });
    }
    return store;
  }

  get current(): Config {
    return this.#config;
  }

  get bridgeIeee(): string {
    return this.#config.bridge.ieee_address!;
  }

  /**
   * Applies `change` to a copy, validates it, writes it, and only then makes
   * it current. Updates run one after another, each on the result of the one
   * before, so two concurrent updates can't lose each other's change.
   */
  async update(change: (draft: Config) => void): Promise<Config> {
    const run = this.#writing.then(async () => {
      const draft = structuredClone(this.#config);
      change(draft);
      const result = ConfigSchema.safeParse(draft);
      if (!result.success) throw new UserError(describeIssues(result.error));
      await this.#write(result.data);
      this.#config = result.data;
      return result.data;
    });
    this.#writing = run.then(() => {}, () => {});
    return run;
  }

  async #write(config: Config): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, HEADER + stringify(config), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }
}
