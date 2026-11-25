/**
 * Made-up sensors for tests and for working on the web UI away from the Pi.
 * Started with ARANET2MQTT_SOURCE=fake.
 */

import { EventEmitter } from 'node:events';

import type { AranetStatus, Reading, ReadingSource, SourceEvents, SourceStatus, SourceTiming } from './types.ts';

interface FakeSensor {
  name: string;
  address: string;
  co2: number;
}

function statusFor(co2: number): AranetStatus {
  if (co2 < 1000) return 'green';
  if (co2 < 1400) return 'yellow';
  return 'red';
}

export class FakeSource extends EventEmitter<SourceEvents> implements ReadingSource {
  readonly sensors: FakeSensor[];
  #status: SourceStatus = { state: 'stopped' };
  #timer?: NodeJS.Timeout;
  #intervalMs: number;

  constructor(options: { intervalMs?: number; sensors?: FakeSensor[] } = {}) {
    super();
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.sensors = options.sensors ?? [
      { name: 'Aranet4 0FA1E', address: 'F0:00:00:00:0F:1E', co2: 640 },
      { name: 'Aranet4 0FA2B', address: 'F0:00:00:00:0F:2B', co2: 1180 },
    ];
  }

  get status(): SourceStatus {
    return this.#status;
  }

  start(): void {
    this.#status = { state: 'running' };
    this.emit('status');
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#status = { state: 'stopped' };
    this.emit('status');
  }

  discover(): void {
    const at = new Date();
    for (const s of this.sensors) this.emit('sighting', { name: s.name, address: s.address, rssi: null, model: 'Aranet4', at });
    this.#status = { ...this.#status, lastDiscoveryAt: at.toISOString() };
    this.emit('status');
  }

  reconfigure(timing: SourceTiming): void {
    this.#intervalMs = timing.scanInterval * 1000;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => this.tick(), this.#intervalMs);
      this.#timer.unref();
    }
  }

  /** Emits one reading per sensor; public so tests can drive it. */
  tick(): void {
    const at = new Date();
    for (const s of this.sensors) {
      s.co2 = Math.max(400, Math.round(s.co2 + (Math.random() - 0.5) * 60));
      this.emitReading({
        device: s.name,
        co2: s.co2,
        temperature: 21 + Math.round(Math.random() * 20) / 10,
        humidity: 45,
        pressure: 1013.2,
        battery: 90,
        status: statusFor(s.co2),
        at,
      });
    }
  }

  emitReading(reading: Reading): void {
    this.#status = { ...this.#status, state: 'running', lastReadingAt: reading.at.toISOString() };
    this.emit('reading', reading);
  }
}
