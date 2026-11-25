/**
 * Parsers for the upstream `aranet` CLI's JSON output (pinned commit, see the
 * Dockerfile). `watch --passive --json --compact` prints one object per line
 * on stdout, between human-readable lines on stderr; `scan --json --compact`
 * prints one object.
 */

import type { AranetStatus, Reading, Sighting } from './types.ts';

const STATUSES: ReadonlySet<string> = new Set(['green', 'yellow', 'red', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function status(value: unknown): AranetStatus {
  const s = String(value).toLowerCase();
  return STATUSES.has(s) ? (s as AranetStatus) : 'unknown';
}

/** One stdout line of `aranet watch --passive --json --compact`; `undefined` if it isn't a reading. */
export function parseWatchLine(line: string, now: Date = new Date()): Reading | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.device !== 'string' || !value.device) return undefined;
  const { co2, temperature, humidity, pressure, battery } = value;
  if (!finite(co2) || !finite(temperature) || !finite(humidity) || !finite(pressure) || !finite(battery)) return undefined;
  // We always pass --celsius --hpa; anything else means the CLI changed under us.
  if (value.temperature_unit !== undefined && value.temperature_unit !== 'C') return undefined;
  if (value.pressure_unit !== undefined && value.pressure_unit !== 'hPa') return undefined;
  const at = typeof value.timestamp === 'string' ? new Date(value.timestamp) : now;
  return {
    device: value.device,
    co2,
    temperature,
    humidity,
    pressure,
    battery,
    status: status(value.status),
    at: Number.isNaN(at.getTime()) ? now : at,
  };
}

/** The stdout of `aranet scan --json --compact`. */
export function parseScanOutput(output: string, now: Date = new Date()): Sighting[] {
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(value) || !Array.isArray(value.devices)) continue;
    return value.devices.flatMap((d): Sighting[] => {
      if (!isRecord(d) || typeof d.address !== 'string' || !d.address) return [];
      return [{
        name: typeof d.name === 'string' && d.name ? d.name : null,
        address: d.address.toUpperCase(),
        rssi: finite(d.rssi) ? d.rssi : null,
        model: typeof d.device_type === 'string' ? d.device_type : null,
        at: now,
      }];
    });
  }
  return [];
}
