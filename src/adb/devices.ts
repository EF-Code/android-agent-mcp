import { randomUUID } from 'node:crypto';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import type { DeviceSummary } from '../types.js';
import { validateSerial } from '../validation/common.js';
import { AdbClient } from './client.js';

export interface DeviceSession {
  sessionId: string;
  serial: string;
  selectedAt: string;
}

export function parseAdbDevices(
  output: string,
  selectedSerial: string | null = null,
): DeviceSummary[] {
  const devices: DeviceSummary[] = [];
  for (const rawLine of output.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line === 'List of devices attached') continue;
    const match =
      /^(\S+)\s+(device|unauthorized|offline|no permissions|unknown)(?:\s+(.*))?$/u.exec(line);
    if (match === null) continue;
    const [, serial, stateValue, attributeText] = match;
    if (serial === undefined || stateValue === undefined) continue;

    const attributes: Record<string, string> = {};
    for (const field of (attributeText ?? '').split(/\s+/u).filter((value) => value.length > 0)) {
      const separator = field.indexOf(':');
      if (separator > 0) attributes[field.slice(0, separator)] = field.slice(separator + 1);
    }

    const state: DeviceSummary['state'] =
      stateValue === 'device' ||
      stateValue === 'unauthorized' ||
      stateValue === 'offline' ||
      stateValue === 'no permissions'
        ? stateValue
        : 'unknown';
    devices.push({
      serial,
      transport: attributes.transport ?? null,
      state,
      authorized: state === 'device',
      selected: selectedSerial === serial,
      model: attributes.model ?? null,
      manufacturer: attributes.manufacturer ?? null,
      product: attributes.product ?? null,
      device: attributes.device ?? null,
      usb: attributes.usb ?? null,
      transportId: attributes.transport_id ?? null,
      rawAttributes: attributes,
    });
  }
  return devices;
}

export class DeviceManager {
  private selectedSerial: string | null = null;
  private session: DeviceSession | null = null;
  private wasConnected = false;
  private requiresReselection = false;

  constructor(
    private readonly adb: AdbClient,
    private readonly autoSelectSingleDevice: boolean,
    private readonly onDisconnect: (serial: string) => void = () => undefined,
  ) {}

  async list(): Promise<DeviceSummary[]> {
    const output = await this.adb.text(this.adb.host(['devices', '-l']));
    let devices = parseAdbDevices(output, this.selectedSerial);
    const selected =
      this.selectedSerial === null
        ? null
        : devices.find((device) => device.serial === this.selectedSerial);

    if (this.selectedSerial !== null && selected === undefined) {
      if (this.wasConnected) {
        this.requiresReselection = true;
        this.onDisconnect(this.selectedSerial);
      }
      this.wasConnected = false;
      devices = devices.map((device) => ({ ...device, selected: false }));
    } else if (selected !== undefined && selected !== null) {
      if (this.wasConnected && !selected.authorized) {
        this.requiresReselection = true;
        this.onDisconnect(selected.serial);
      }
      this.wasConnected = selected.authorized;
    }

    if (this.selectedSerial === null && this.autoSelectSingleDevice) {
      const authorized = devices.filter((device) => device.authorized);
      if (authorized.length === 1) {
        this.selectedSerial = authorized[0]!.serial;
        this.session = {
          sessionId: randomUUID(),
          serial: this.selectedSerial,
          selectedAt: new Date().toISOString(),
        };
        devices = devices.map((device) => ({
          ...device,
          selected: device.serial === this.selectedSerial,
        }));
        this.wasConnected = true;
      }
    }

    if (this.requiresReselection) {
      devices = devices.map((device) => ({ ...device, selected: false }));
    }

    return devices;
  }

  async select(serial: string): Promise<{ device: DeviceSummary; session: DeviceSession }> {
    validateSerial(serial);
    const devices = await this.list();
    const device = devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new AppError(
        ErrorCode.DeviceNotFound,
        'The requested serial was not present in the current ADB device list.',
        {
          retryable: true,
          details: { serial },
        },
      );
    }
    if (device.state === 'unauthorized') {
      throw new AppError(
        ErrorCode.DeviceUnauthorized,
        'Accept the USB debugging authorization prompt on the phone.',
        {
          retryable: true,
          details: { serial },
        },
      );
    }
    if (device.state === 'offline') {
      throw new AppError(
        ErrorCode.DeviceOffline,
        'The selected device is offline; reconnect it before control actions.',
        {
          retryable: true,
          details: { serial },
        },
      );
    }
    if (device.state !== 'device') {
      throw new AppError(
        ErrorCode.DeviceNotFound,
        'The selected serial is not currently usable by ADB.',
        {
          retryable: true,
          details: { serial, state: device.state },
        },
      );
    }

    this.selectedSerial = serial;
    this.session = { sessionId: randomUUID(), serial, selectedAt: new Date().toISOString() };
    this.requiresReselection = false;
    this.wasConnected = true;
    return { device: { ...device, selected: true }, session: this.session };
  }

  async requireSelected(options: { checkConnection?: boolean } = {}): Promise<DeviceSession> {
    if (this.session === null || this.selectedSerial === null) {
      throw new AppError(
        ErrorCode.NoDeviceSelected,
        'Select one authorized Android device before using control tools.',
        {
          retryable: true,
        },
      );
    }
    if (this.requiresReselection) {
      throw new AppError(
        ErrorCode.DeviceDisconnected,
        'The selected device was disconnected; select it again before resuming control.',
        {
          retryable: true,
          details: { serial: this.selectedSerial, sessionId: this.session.sessionId },
        },
      );
    }
    if (options.checkConnection === false) return this.session;
    const devices = await this.list();
    const selected = devices.find((device) => device.serial === this.selectedSerial);
    if (selected === undefined) {
      throw new AppError(
        ErrorCode.DeviceDisconnected,
        'The selected device is no longer connected.',
        {
          retryable: true,
          details: { serial: this.selectedSerial, sessionId: this.session.sessionId },
        },
      );
    }
    if (!selected.authorized) {
      throw new AppError(
        ErrorCode.DeviceUnauthorized,
        'The selected device is no longer authorized.',
        {
          retryable: true,
          details: { serial: this.selectedSerial, state: selected.state },
        },
      );
    }
    return this.session;
  }

  get selected(): DeviceSession | null {
    return this.session;
  }
}
