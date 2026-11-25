import { createHash, randomBytes } from 'node:crypto';

/**
 * Z2M identifies devices by a 64-bit IEEE address written `0x` + 16 hex
 * digits. A sensor's address is derived from its Bluetooth name, which holds
 * its serial ("Aranet4 1A2B3"), so it is stable across restarts, broker
 * changes and a lost configuration file.
 */
export function deviceIeee(bleName: string): string {
  return `0x${createHash('sha256').update(`aranet2mqtt:${bleName}`).digest('hex').slice(0, 16)}`;
}

/** The bridge's own ("coordinator") address, generated once and saved. */
export function randomIeee(): string {
  return `0x${randomBytes(8).toString('hex')}`;
}

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;

/** Upstream prints the address in place of the name when BlueZ has no name yet. */
export function isMacAddress(value: string): boolean {
  return MAC.test(value);
}

/** "Aranet4 1A2B3" → "Aranet4". Only Aranet4 is supported for now. */
export function modelFromName(bleName: string): string {
  return bleName.split(' ')[0] ?? bleName;
}

export const SUPPORTED_MODELS: ReadonlySet<string> = new Set(['Aranet4']);
