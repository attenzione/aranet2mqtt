import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseScanOutput, parseWatchLine } from '../src/source/parse.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseWatchLine', () => {
  it('reads real `aranet watch --passive` output and skips the banner', () => {
    const readings = fixture('watch.jsonl').split('\n').map((line) => parseWatchLine(line)).filter((r) => r !== undefined);
    expect(readings).toHaveLength(3);
    expect(readings[0]).toEqual({
      device: 'Aranet4 4C5D6',
      co2: 1651,
      temperature: 21.9,
      humidity: 51,
      pressure: 1018.4,
      battery: 88,
      status: 'red',
      at: new Date('2026-11-25T20:49:12.885Z'),
    });
  });

  it('rejects lines that are not readings', () => {
    expect(parseWatchLine('Scan failed: le-connection-abort-by-local. Retrying...')).toBeUndefined();
    expect(parseWatchLine('{not json')).toBeUndefined();
    expect(parseWatchLine('{"device":"Aranet4 1","co2":"high"}')).toBeUndefined();
  });

  it('rejects units other than °C and hPa', () => {
    const line = '{"device":"Aranet4 1","co2":500,"temperature":70,"temperature_unit":"F","humidity":40,"pressure":1000,"pressure_unit":"hPa","battery":90,"status":"Green"}';
    expect(parseWatchLine(line)).toBeUndefined();
  });

  it('maps an unknown status to "unknown"', () => {
    const line = '{"device":"Aranet4 1","co2":500,"temperature":20,"humidity":40,"pressure":1000,"battery":90,"status":"Purple"}';
    expect(parseWatchLine(line)?.status).toBe('unknown');
  });
});

describe('parseScanOutput', () => {
  it('reads real `aranet scan` output', () => {
    const at = new Date('2026-11-25T20:00:00Z');
    expect(parseScanOutput(fixture('scan.json'), at)).toEqual([
      { name: 'Aranet4 1A2B3', address: 'C0:FF:EE:00:00:01', rssi: null, model: 'Aranet4', at },
    ]);
  });

  it('returns nothing for output without devices', () => {
    expect(parseScanOutput('Error: Failed to scan for devices\n')).toEqual([]);
  });
});
