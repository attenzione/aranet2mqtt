import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import mqtt, { type IClientOptions, type IClientPublishOptions, type MqttClient } from 'mqtt';

import type { MqttConfig } from '../config.ts';
import type { Logger } from '../log.ts';

export function brokerUrl(cfg: Pick<MqttConfig, 'protocol' | 'host' | 'port' | 'path'>): string {
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
  const path = cfg.protocol === 'ws' || cfg.protocol === 'wss' ? (cfg.path.startsWith('/') ? cfg.path : `/${cfg.path}`) : '';
  return `${cfg.protocol}://${host || 'not-configured'}:${cfg.port}${path}`;
}

export function clientOptions(cfg: MqttConfig, extra: Partial<IClientOptions> = {}): IClientOptions {
  const tls = cfg.protocol === 'mqtts' || cfg.protocol === 'wss';
  return {
    clientId: cfg.client_id,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    protocolVersion: cfg.version,
    keepalive: cfg.keepalive,
    clean: cfg.clean,
    connectTimeout: cfg.connect_timeout * 1000,
    reconnectPeriod: cfg.reconnect_period * 1000,
    ...(tls ? {
      ca: cfg.tls.ca || undefined,
      cert: cfg.tls.cert || undefined,
      key: cfg.tls.key || undefined,
      rejectUnauthorized: cfg.tls.reject_unauthorized,
    } : {}),
    ...extra,
  };
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = String((err as NodeJS.ErrnoException).code);
  if (code === 'ECONNREFUSED') return 'Connection refused: nothing listens on that host and port';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  return err.message;
}

export interface Will {
  topic: string;
  payload: string;
}

export type Outgoing = [topic: string, payload: string, options: IClientPublishOptions];

interface LinkEvents {
  connect: [];
  disconnect: [];
  message: [topic: string, payload: Buffer];
}

/** The bridge's one broker connection: last will, reconnects, and a status for the UI. */
export class MqttLink extends EventEmitter<LinkEvents> {
  readonly #logger: Logger;
  #client?: MqttClient;
  #config?: MqttConfig;
  #connected = false;
  #error?: string;

  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get error(): string | undefined {
    return this.#error;
  }

  get url(): string | undefined {
    return this.#config ? brokerUrl(this.#config) : undefined;
  }

  get configured(): boolean {
    return Boolean(this.#config?.host);
  }

  start(cfg: MqttConfig, will: Will): void {
    this.#config = cfg;
    this.#error = undefined;
    if (!cfg.host) {
      this.#error = 'No broker configured yet';
      this.#logger.warn('MQTT: no broker host configured; set it in the web UI');
      return;
    }
    const url = brokerUrl(cfg);
    this.#logger.info(`MQTT: connecting to ${url} as ${cfg.client_id}`);
    const client = mqtt.connect(url, clientOptions(cfg, { will: { topic: will.topic, payload: Buffer.from(will.payload), qos: 1, retain: true } }));
    this.#client = client;
    client.on('connect', () => {
      this.#connected = true;
      this.#error = undefined;
      this.#logger.info(`MQTT: connected to ${url}`);
      this.emit('connect');
    });
    client.on('close', () => {
      if (!this.#connected) return;
      this.#connected = false;
      this.#logger.warn(`MQTT: disconnected from ${url}`);
      this.emit('disconnect');
    });
    client.on('error', (err) => {
      const message = describe(err);
      if (message !== this.#error) this.#logger.warn(`MQTT: ${message}`);
      this.#error = message;
    });
    client.on('message', (topic, payload) => this.emit('message', topic, payload));
  }

  /** Publishes now if connected; otherwise drops it (state is republished on connect). */
  async publish(topic: string, payload: string, options: IClientPublishOptions): Promise<boolean> {
    const client = this.#client;
    if (!client || !this.#connected) return false;
    try {
      await client.publishAsync(topic, payload, options);
      return true;
    } catch (err) {
      this.#logger.warn(`MQTT: publish to ${topic} failed: ${describe(err)}`);
      return false;
    }
  }

  async subscribe(topics: string[]): Promise<void> {
    if (!this.#client || !this.#connected) return;
    await this.#client.subscribeAsync(topics, { qos: 1 });
  }

  /** Sends `final` (the offline state) while still connected, then disconnects. */
  async stop(final: Outgoing[] = []): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (!client) return;
    if (this.#connected) {
      for (const [topic, payload, options] of final) {
        await client.publishAsync(topic, payload, options).catch(() => {});
      }
    }
    this.#connected = false;
    await client.endAsync().catch(() => {});
    this.emit('disconnect');
  }
}

/** The web UI's "Test connection": connect with a throwaway client id, then disconnect. */
export async function testConnection(cfg: MqttConfig, timeoutMs = 10_000): Promise<{ ok: boolean; message: string }> {
  if (!cfg.host) return { ok: false, message: 'Enter the broker host' };
  const url = brokerUrl(cfg);
  const client = mqtt.connect(url, clientOptions(cfg, {
    clientId: `${cfg.client_id}-test-${randomBytes(3).toString('hex')}`,
    reconnectPeriod: 0,
    connectTimeout: Math.min(cfg.connect_timeout * 1000, timeoutMs),
    clean: true,
  }));
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, message: `${url} did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve({ ok: true, message: `Connected to ${url}` });
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, message: describe(err) });
      });
    });
  } finally {
    await client.endAsync(true).catch(() => {});
  }
}
