import { AdbClient } from './client.js';

const PROPERTY_NAMES = [
  'ro.product.manufacturer',
  'ro.product.model',
  'ro.product.name',
  'ro.product.device',
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.product.cpu.abilist',
] as const;

export interface DeviceProperties {
  manufacturer: string | null;
  model: string | null;
  product: string | null;
  device: string | null;
  androidVersion: string | null;
  apiLevel: number | null;
  abiList: string[];
}

function nonEmpty(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDisplayValue(output: string): { width: number; height: number } | null {
  const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/u.exec(output);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

export class AdbProperties {
  constructor(private readonly adb: AdbClient) {}

  async read(serial: string): Promise<DeviceProperties> {
    const values = new Map<string, string | null>();
    for (const property of PROPERTY_NAMES) {
      values.set(property, nonEmpty(await this.adb.text(this.adb.shell(serial, ['getprop', property], { maxOutputBytes: 4_096 }))));
    }

    return {
      manufacturer: values.get('ro.product.manufacturer') ?? null,
      model: values.get('ro.product.model') ?? null,
      product: values.get('ro.product.name') ?? null,
      device: values.get('ro.product.device') ?? null,
      androidVersion: values.get('ro.build.version.release') ?? null,
      apiLevel: numberOrNull(values.get('ro.build.version.sdk') ?? null),
      abiList: (values.get('ro.product.cpu.abilist') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    };
  }

  async display(serial: string): Promise<{ resolution: { width: number; height: number } | null; density: number | null }> {
    const size = await this.adb.text(this.adb.shell(serial, ['wm', 'size'], { maxOutputBytes: 8_192 }));
    const densityOutput = await this.adb.text(this.adb.shell(serial, ['wm', 'density'], { maxOutputBytes: 8_192 }));
    const densityMatch = /(?:Physical|Override) density:\s*(\d+)/u.exec(densityOutput);
    const density = densityMatch === null ? null : Number(densityMatch[1]);
    return {
      resolution: parseDisplayValue(size),
      density: density !== null && Number.isSafeInteger(density) && density > 0 ? density : null,
    };
  }

  async battery(serial: string): Promise<{ level: number | null; status: string | null; plugged: string | null; temperatureC: number | null }> {
    const output = await this.adb.text(this.adb.shell(serial, ['dumpsys', 'battery'], { maxOutputBytes: 32_000 }));
    const value = (name: string): string | null => {
      const match = new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mu').exec(output);
      return match?.[1]?.trim() ?? null;
    };
    const level = numberOrNull(value('level'));
    const rawTemperature = numberOrNull(value('temperature'));
    return {
      level: level === null ? null : Math.min(level, 100),
      status: value('status'),
      plugged: value('AC powered') === 'true' ? 'AC' : value('USB powered') === 'true' ? 'USB' : value('Wireless powered') === 'true' ? 'WIRELESS' : null,
      temperatureC: rawTemperature === null ? null : rawTemperature / 10,
    };
  }

  async lockState(serial: string): Promise<'locked' | 'unlocked' | 'unknown'> {
    const output = await this.adb.text(this.adb.shell(serial, ['dumpsys', 'window'], { maxOutputBytes: 128_000 }));
    if (/mShowingLockscreen=true|mDreamingLockscreen=true|mInputRestricted=true/u.test(output)) return 'locked';
    if (/mShowingLockscreen=false|mDreamingLockscreen=false|mInputRestricted=false/u.test(output)) return 'unlocked';
    return 'unknown';
  }
}
