import type { EventEmitter } from 'node:events';

export type AranetStatus = 'green' | 'yellow' | 'red' | 'error' | 'unknown';

/** One reading taken from a sensor's Bluetooth broadcast. */
export interface Reading {
  /** As upstream printed it: the Bluetooth name, or the address when BlueZ has no name yet. */
  device: string;
  co2: number;
  /** °C */
  temperature: number;
  /** % */
  humidity: number;
  /** hPa */
  pressure: number;
  /** % */
  battery: number;
  status: AranetStatus;
  at: Date;
}

/** A sensor seen by a discovery scan. */
export interface Sighting {
  name: string | null;
  address: string;
  rssi: number | null;
  model: string | null;
  at: Date;
}

export type SourceState = 'stopped' | 'starting' | 'running' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** The latest problem, for the web UI. */
  message?: string;
  lastReadingAt?: string;
  lastDiscoveryAt?: string;
}

export interface SourceEvents {
  reading: [reading: Reading];
  sighting: [sighting: Sighting];
  status: [];
}

export interface SourceTiming {
  scanInterval: number;
  listenDuration: number;
  discoveryInterval: number;
}

/** Where readings come from: the upstream CLI on the Pi, or a fake one in tests. */
export interface ReadingSource extends EventEmitter<SourceEvents> {
  readonly status: SourceStatus;
  start(): void;
  stop(): Promise<void>;
  /** Runs a discovery scan now (it is also run on a timer). */
  discover(): void;
  /** Applies new timing; restarts the listener if it changed. */
  reconfigure(timing: SourceTiming): void;
}
