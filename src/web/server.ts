/**
 * The web UI's server: a JSON API under /api and the built UI as static files.
 * Everything except /api/health needs the password (HTTP Basic, any user
 * name), because the UI is meant to be published through a reverse proxy.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Bridge } from '../bridge/bridge.ts';
import { testConnection } from '../bridge/mqtt.ts';
import {
  AvailabilitySchema, BluetoothSchema, describeIssues, MqttSchema, UserError, type ConfigStore, type MqttConfig,
} from '../config.ts';
import { LEVELS, type Logger } from '../log.ts';

export interface WebOptions {
  bridge: Bridge;
  store: ConfigStore;
  logger: Logger;
  /** Unset: the API answers 503 until ARANET2MQTT_PASSWORD is set. */
  password: string | undefined;
  uiDir: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function authorized(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(given), digest(password));
}

/** The password and TLS key never leave the server; the UI only learns whether they are set. */
function redactMqtt(mqtt: MqttConfig) {
  return {
    ...mqtt,
    password: '',
    password_set: mqtt.password !== '',
    tls: { ...mqtt.tls, key: '', key_set: mqtt.tls.key !== '' },
  };
}

/**
 * The form sends the whole MQTT section. An omitted (or null) password or TLS
 * key keeps the stored one; an empty string clears it.
 */
function mergeMqtt(current: MqttConfig, body: unknown): MqttConfig {
  if (typeof body !== 'object' || body === null) throw new UserError('Expected the MQTT settings as JSON');
  const input = { ...(body as Record<string, unknown>) };
  delete input.password_set;
  input.password ??= current.password;
  const tls = typeof input.tls === 'object' && input.tls !== null ? { ...(input.tls as Record<string, unknown>) } : {};
  delete tls.key_set;
  tls.key ??= current.tls.key;
  input.tls = tls;
  const result = MqttSchema.safeParse(input);
  if (!result.success) throw new UserError(describeIssues(result.error));
  return result.data;
}

const AdvancedSchema = z.object({
  bluetooth: BluetoothSchema,
  availability: AvailabilitySchema,
  log_level: z.enum(LEVELS),
  z2m_version: z.string(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new UserError(describeIssues(result.error));
  return result.data;
}

export async function createWebServer(options: WebOptions): Promise<FastifyInstance> {
  const { bridge, store, logger, password, uiDir } = options;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/health') return;
    if (!password) {
      await reply.code(503).type('text/plain').send('Set ARANET2MQTT_PASSWORD to use the web UI.');
      return;
    }
    if (!authorized(request.headers.authorization, password)) {
      await reply.code(401).header('WWW-Authenticate', 'Basic realm="aranet2mqtt", charset="UTF-8"').send({ error: 'Password required' });
    }
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof UserError) return reply.code(400).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    logger.error('Web request failed:', error);
    return reply.code(500).send({ error: 'Internal error; see the logs' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/status', async () => bridge.status());

  app.get('/api/config', async () => {
    const { mqtt, bluetooth, availability, log_level, bridge } = store.current;
    return { mqtt: redactMqtt(mqtt), bluetooth, availability, log_level, z2m_version: bridge.version };
  });

  app.put('/api/config/mqtt', async (request) => {
    await bridge.applyMqtt(mergeMqtt(store.current.mqtt, request.body));
    return { ok: true, mqtt: redactMqtt(store.current.mqtt) };
  });

  app.post('/api/mqtt/test', async (request) => testConnection(mergeMqtt(store.current.mqtt, request.body)));

  app.put('/api/config/advanced', async (request) => {
    await bridge.applyAdvanced(parse(AdvancedSchema, request.body));
    return { ok: true };
  });

  app.post('/api/permit_join', async (request) => {
    const { time } = parse(z.object({ time: z.number().min(0).max(254) }), request.body);
    return { time: await bridge.setPermitJoin(time) };
  });

  app.post('/api/discover', async () => {
    bridge.discover();
    return { ok: true };
  });

  app.post('/api/devices', async (request) => {
    const { name, friendly_name } = parse(z.object({ name: z.string().min(1), friendly_name: z.string().optional() }), request.body);
    const [ieee] = await bridge.addDevice(name, friendly_name);
    return { ieee_address: ieee };
  });

  app.patch('/api/devices/:ieee', async (request) => {
    const { ieee } = request.params as { ieee: string };
    const { friendly_name } = parse(z.object({ friendly_name: z.string() }), request.body);
    return bridge.renameDevice(ieee, friendly_name);
  });

  app.delete('/api/devices/:ieee', async (request) => {
    const { ieee } = request.params as { ieee: string };
    return bridge.removeDevice(ieee);
  });

  app.get('/api/logs', async () => ({ entries: logger.entries() }));

  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: uiDir });
  } else {
    logger.warn(`Web UI files not found in ${uiDir}; only the API is served`);
  }

  return app;
}
