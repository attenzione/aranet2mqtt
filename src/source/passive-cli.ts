/**
 * Readings from the upstream `aranet` CLI, run as child processes:
 *
 * - `aranet watch --passive` runs for as long as the bridge does. It listens
 *   to the sensors' broadcasts (Smart Home integration must be on) and prints
 *   one JSON reading per sensor per cycle. It is restarted if it exits.
 * - `aranet scan` runs now and then, to learn each sensor's address.
 *
 * Neither ever connects to a sensor, so no pairing is needed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

import type { Logger } from '../log.ts';
import { parseScanOutput, parseWatchLine } from './parse.ts';
import type { ReadingSource, SourceEvents, SourceStatus, SourceTiming } from './types.ts';

export interface PassiveCliOptions extends SourceTiming {
  binary: string;
  logger: Logger;
  /** Replaced in tests. */
  spawn?: typeof spawn;
}

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const SCAN_SECONDS = 15;
const FIRST_DISCOVERY_MS = 20_000;

export class PassiveCliSource extends EventEmitter<SourceEvents> implements ReadingSource {
  readonly #binary: string;
  readonly #logger: Logger;
  readonly #spawn: typeof spawn;
  #timing: SourceTiming;
  #status: SourceStatus = { state: 'stopped' };
  #stopped = true;
  #watch?: ChildProcess;
  #scan?: ChildProcess;
  #restartDelay = RESTART_MIN_MS;
  #restartTimer?: NodeJS.Timeout;
  #discoveryTimer?: NodeJS.Timeout;

  constructor(options: PassiveCliOptions) {
    super();
    this.#binary = options.binary;
    this.#logger = options.logger;
    this.#spawn = options.spawn ?? spawn;
    this.#timing = { scanInterval: options.scanInterval, listenDuration: options.listenDuration, discoveryInterval: options.discoveryInterval };
  }

  get status(): SourceStatus {
    return this.#status;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#setStatus({ state: 'starting' });
    this.#startWatch();
    this.#scheduleDiscovery(FIRST_DISCOVERY_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#discoveryTimer);
    await Promise.all([terminate(this.#watch), terminate(this.#scan)]);
    this.#setStatus({ state: 'stopped' });
  }

  reconfigure(timing: SourceTiming): void {
    const restart = timing.scanInterval !== this.#timing.scanInterval || timing.listenDuration !== this.#timing.listenDuration;
    const rediscover = timing.discoveryInterval !== this.#timing.discoveryInterval;
    this.#timing = { ...timing };
    if (this.#stopped) return;
    if (rediscover) this.#scheduleDiscovery(this.#timing.discoveryInterval * 1000);
    if (restart && this.#watch) {
      this.#logger.info('Bluetooth timing changed; restarting the listener');
      // The exit handler starts it again with the new arguments.
      this.#restartDelay = 0;
      this.#watch.kill('SIGINT');
    }
  }

  discover(): void {
    if (this.#stopped || this.#scan) return;
    const args = ['scan', '--json', '--compact', '--no-color', '-t', String(SCAN_SECONDS)];
    this.#logger.debug(`Running ${this.#binary} ${args.join(' ')}`);
    const child = this.#spawn(this.#binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#scan = child;
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    this.#lines(child.stderr, (line) => this.#logger.debug(`[aranet scan] ${line}`));
    child.on('error', (err) => this.#logger.warn(`Discovery scan failed to start: ${err.message}`));
    child.on('close', (code) => {
      this.#scan = undefined;
      if (code !== 0) {
        this.#logger.warn(`Discovery scan exited with code ${String(code)}`);
        return;
      }
      const sightings = parseScanOutput(stdout);
      this.#logger.debug(`Discovery scan saw ${sightings.length} sensor(s)`);
      this.#setStatus({ ...this.#status, lastDiscoveryAt: new Date().toISOString() });
      for (const sighting of sightings) this.emit('sighting', sighting);
    });
  }

  #startWatch(): void {
    const { scanInterval, listenDuration } = this.#timing;
    const args = [
      'watch', '--passive', '--json', '--compact', '--no-color', '--celsius', '--hpa',
      '-i', String(scanInterval), '-T', String(listenDuration),
    ];
    this.#logger.info(`Starting ${this.#binary} ${args.join(' ')}`);
    const child = this.#spawn(this.#binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#watch = child;

    this.#lines(child.stdout, (line) => {
      const reading = parseWatchLine(line);
      if (!reading) {
        this.#logger.debug(`[aranet watch] ${line}`);
        return;
      }
      this.#restartDelay = RESTART_MIN_MS;
      this.#setStatus({ ...this.#status, state: 'running', message: undefined, lastReadingAt: reading.at.toISOString() });
      this.emit('reading', reading);
    });
    this.#lines(child.stderr, (line) => this.#onWatchStderr(line));

    child.on('error', (err) => {
      const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `The aranet binary was not found (${this.#binary})`
        : `The aranet listener failed to start: ${err.message}`;
      this.#logger.error(message);
      this.#setStatus({ ...this.#status, state: 'error', message });
    });
    child.on('close', (code, signal) => {
      if (this.#watch === child) this.#watch = undefined;
      if (this.#stopped) return;
      const delay = this.#restartDelay;
      if (delay > 0) {
        const message = `The aranet listener exited (${signal ?? `code ${String(code)}`}); restarting in ${Math.round(delay / 1000)} s`;
        this.#logger.warn(message);
        this.#setStatus({ ...this.#status, state: 'error', message });
      }
      this.#restartDelay = Math.min(Math.max(delay * 2, RESTART_MIN_MS), RESTART_MAX_MS);
      this.#restartTimer = setTimeout(() => this.#startWatch(), delay);
    });
  }

  #onWatchStderr(line: string): void {
    if (/^(Watching:|Interval:|-{10,})/.test(line)) {
      this.#logger.debug(`[aranet watch] ${line}`);
      if (this.#status.state === 'starting') this.#setStatus({ ...this.#status, state: 'running' });
      return;
    }
    if (line.startsWith('No Aranet devices')) {
      this.#logger.debug(`[aranet watch] ${line}`);
      this.#setStatus({ ...this.#status, message: 'No sensor broadcasts heard in the last listen' });
      return;
    }
    // "Scan failed: …", "Failed to parse advertisement from …", "Error: …"
    this.#logger.warn(`[aranet watch] ${line}`);
    if (/^(Scan failed|Error)/.test(line)) this.#setStatus({ ...this.#status, state: 'error', message: line });
  }

  #scheduleDiscovery(delayMs: number): void {
    clearTimeout(this.#discoveryTimer);
    this.#discoveryTimer = setTimeout(() => {
      this.discover();
      this.#scheduleDiscovery(this.#timing.discoveryInterval * 1000);
    }, delayMs);
    this.#discoveryTimer.unref();
  }

  #lines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
    if (!stream) return;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      if (line.trim()) onLine(line.trim());
    });
  }

  #setStatus(status: SourceStatus): void {
    this.#status = status;
    this.emit('status');
  }
}

/** SIGINT first: upstream stops cleanly on Ctrl+C. */
async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}
