import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function obj(v: unknown): Obj | null {
  return isObj(v) ? v : null;
}

export async function readJsonFile<T = unknown>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text) as T;
}

/** Write via temp file + rename so a crash never leaves a half-written file. Mode 0600: these files can hold tokens. */
export async function writeJsonFileAtomic(file: string, data: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await rename(tmp, file);
}
