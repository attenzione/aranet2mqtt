/**
 * aranet2mqtt: Aranet4 sensors on MQTT as a Zigbee2MQTT-style bridge.
 *
 * Environment:
 *   ARANET2MQTT_DATA      data directory, holds configuration.yaml (default /data)
 *   ARANET2MQTT_PASSWORD  web UI password (required for the UI)
 *   ARANET2MQTT_PORT      web UI port (default 8080)
 *   ARANET2MQTT_SOURCE    "aranet" (default) or "fake" for made-up sensors
 *   ARANET_BIN            upstream CLI (default "aranet" on PATH)
 *   ARANET_REF            upstream commit, shown in bridge/info (set by the image)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bridge } from './bridge/bridge.ts';
import { MqttLink } from './bridge/mqtt.ts';
import { ConfigStore } from './config.ts';
import { Logger } from './log.ts';
import { FakeSource } from './source/fake.ts';
import { PassiveCliSource } from './source/passive-cli.ts';
import type { ReadingSource } from './source/types.ts';
import { createWebServer } from './web/server.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// From src/ (node --watch src/main.ts) and from dist/server/ alike.
const projectRoot = root.endsWith('/dist/') ? join(root, '..') : root;
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string };

const env = process.env;
const dataDir = env.ARANET2MQTT_DATA ?? '/data';
const port = Number(env.ARANET2MQTT_PORT ?? 8080);

async function main(): Promise<void> {
  const logger = new Logger();
  const store = await ConfigStore.load(join(dataDir, 'configuration.yaml'));
  logger.level = store.current.log_level;
  logger.info(`aranet2mqtt ${pkg.version}; configuration ${store.path}; bridge ${store.bridgeIeee}`);

  const { bluetooth } = store.current;
  const timing = { scanInterval: bluetooth.scan_interval, listenDuration: bluetooth.listen_duration, discoveryInterval: bluetooth.discovery_interval };
  const source: ReadingSource = env.ARANET2MQTT_SOURCE === 'fake'
    ? new FakeSource({ intervalMs: bluetooth.scan_interval * 1000 })
    : new PassiveCliSource({ binary: env.ARANET_BIN ?? 'aranet', logger, ...timing });

  const bridge = new Bridge({
    store,
    source,
    mqtt: new MqttLink(logger),
    logger,
    version: pkg.version,
    commit: (env.ARANET_REF ?? 'dev').slice(0, 7),
  });

  const web = await createWebServer({
    bridge, store, logger, password: env.ARANET2MQTT_PASSWORD || undefined, uiDir: join(projectRoot, 'dist', 'ui'),
  });
  if (!env.ARANET2MQTT_PASSWORD) logger.warn('ARANET2MQTT_PASSWORD is not set: the web UI is locked');

  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    logger.info('Stopping');
    const force = setTimeout(() => process.exit(code), 10_000);
    force.unref();
    await web.close().catch(() => {});
    await bridge.stop().catch((err: unknown) => logger.error('Stopping the bridge failed:', err));
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  bridge.on('restart', () => {
    logger.info('Restart requested over MQTT');
    void shutdown(0);
  });

  bridge.start();
  await web.listen({ host: '0.0.0.0', port });
  logger.info(`Web UI on port ${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
