import { inspect } from 'node:util';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  time: string;
  level: Level;
  message: string;
}

function text(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.message;
  return inspect(part, { depth: 4, breakLength: Infinity });
}

/** Writes to the console and keeps the latest entries for the web UI. */
export class Logger {
  #level: Level;
  readonly #max: number;
  readonly #entries: LogEntry[] = [];
  readonly #quiet: boolean;

  constructor(options: { level?: Level; max?: number; quiet?: boolean } = {}) {
    this.#level = options.level ?? 'info';
    this.#max = options.max ?? 1000;
    this.#quiet = options.quiet ?? false;
  }

  get level(): Level {
    return this.#level;
  }

  set level(level: Level) {
    this.#level = level;
  }

  debug(...parts: unknown[]): void {
    this.#write('debug', parts);
  }

  info(...parts: unknown[]): void {
    this.#write('info', parts);
  }

  warn(...parts: unknown[]): void {
    this.#write('warn', parts);
  }

  error(...parts: unknown[]): void {
    this.#write('error', parts);
  }

  entries(): readonly LogEntry[] {
    return this.#entries;
  }

  #write(level: Level, parts: unknown[]): void {
    if (ORDER[level] < ORDER[this.#level]) return;
    const entry: LogEntry = { time: new Date().toISOString(), level, message: parts.map(text).join(' ') };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.splice(0, this.#entries.length - this.#max);
    if (this.#quiet) return;
    const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${entry.message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}
