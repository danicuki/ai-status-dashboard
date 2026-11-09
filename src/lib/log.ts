function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

let quiet = false;

export function setQuiet(v: boolean): void {
  quiet = v;
}

export const log = {
  info: (...args: unknown[]) => {
    if (!quiet) console.log(ts(), ...args);
  },
  warn: (...args: unknown[]) => {
    if (!quiet) console.warn(ts(), 'WARN', ...args);
  },
  error: (...args: unknown[]) => {
    console.error(ts(), 'ERROR', ...args);
  },
};
