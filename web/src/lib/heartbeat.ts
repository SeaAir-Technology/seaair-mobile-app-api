// Turn a decoded heartbeat payload into the structured data behind the
// Current State cockpit. The decoder returns a JSON tree (a BLE.Msg wrapper
// around an HVAC/Utility device, or a bare device), so — like the backend's
// telemetry extraction — we walk the tree for the first node that looks like
// device telemetry and pull the known fields off it. Every field is optional:
// the cockpit renders fixed slots and shows an em dash for anything missing,
// so partial/unknown payloads degrade gracefully without tiles popping in
// and out.

import type { DecodedPayload } from './types';

export interface CockpitData {
  kind: 'hvac' | 'utility';
  name?: string;
  version?: string;
  mode?: string; // raw enum: STANDBY, COOL, HEAT, HUMIDITY, FAN
  fanSpeed?: number;
  compressorState?: string; // raw enum: ON, OFF
  compressorSpeed?: number;
  temp?: number;
  setpoint?: number;
  humidity?: number;
  targetHumidity?: number;
  powerRate?: number;
  powerTotal?: number;
  voltageMv?: number;
  battery?: number;
  budgetEnabled?: boolean;
  budgetLimit?: number;
  adminPinSet?: boolean;
  alarms: string[];
}

interface Telemetry {
  kind: 'hvac' | 'utility';
  node: Record<string, any>;
}

// HVAC heartbeats carry `temperture` (sic, per bossmarine.proto); Utility
// carries `temperature` + `battery`. Match on those to locate the node.
function findTelemetry(value: unknown, depth = 0): Telemetry | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, any>;
  if (typeof obj.temperture === 'number') return { kind: 'hvac', node: obj };
  if (typeof obj.temperature === 'number' && typeof obj.battery === 'number') {
    return { kind: 'utility', node: obj };
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findTelemetry(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatVoltage(mv: number): string {
  return `${(mv / 1000).toFixed(2)} V`;
}

// Pre-v3.2 firmware fills config.compressor.state from the commanded config
// flag rather than the live relay, so a machine can report "Off" while
// drawing 54A. The power rate settles it: without the compressor the maximum
// draw is ~13A (fan 5.5 + pump 7 + reverse valve 0.6) and with it the minimum
// is ~32A (speed-1 compressor 25 + pump 7) on every firmware's amp table, so
// 20A cleanly separates the two. When a rate reading exists, derive the state
// from it — rate and state then can never contradict on screen; the reported
// field is only trusted when there's no rate to judge by.
export const COMPRESSOR_DRAW_THRESHOLD_A = 20;

export function effectiveCompressorState(
  reported: string | undefined,
  powerRate: number | undefined
): string | undefined {
  if (powerRate !== undefined) {
    return powerRate >= COMPRESSOR_DRAW_THRESHOLD_A ? 'ON' : 'OFF';
  }
  return reported;
}

// Decoder emits camelCase (the old snake_case checks never matched).
// An alarm is active on a real-time event or a latched config flag.
function extractAlarms(n: Record<string, any>): string[] {
  const cfg = n.config ?? {};
  const alarms: string[] = [];
  if (n.compressorShutdown === true || cfg.compressorShutdownAlarm === true) alarms.push('Compressor shutdown');
  if (n.lowPressure === true || cfg.lowPressureAlarm === true) alarms.push('Low pressure');
  if (n.lowVoltage === true || cfg.lowVoltageAlarm === true) alarms.push('Low voltage');
  if (n.highVoltage === true || cfg.highVoltageAlarm === true) alarms.push('High voltage');
  return alarms;
}

export function extractCockpit(decoded: DecodedPayload | null): CockpitData | null {
  if (!decoded) return null;
  const found = findTelemetry(decoded.data);
  if (!found) return null;

  const n = found.node;
  const cfg = n.config && typeof n.config === 'object' ? n.config : {};
  // Enums read from the defaults:true view when present: their zero values
  // (mode STANDBY, compressor ON) are omitted from the wire, and without
  // this a machine in standby would show the last non-standby mode — or
  // none. Same tree shape as `data`, so the walk finds the matching node.
  const fullNode = decoded.dataFull ? findTelemetry(decoded.dataFull)?.node : undefined;
  const cfgFull =
    fullNode?.config && typeof fullNode.config === 'object' ? fullNode.config : cfg;
  // The firmware version rides on the sync wrapper, not the device node.
  const version = str((decoded.data as Record<string, any>)?.syncDevice2Controller?.version);

  if (found.kind === 'hvac') {
    const setpoint = num(cfg.tempreature); // setpoint (sic in proto); 0 = unset
    const targetHumidity = num(cfg.humidity);
    // hvac firmware always populates powerRate, so a wire-omitted rate is a
    // real zero — read it from the defaults view rather than showing a dash.
    const powerRate = num(n.powerRate) ?? num(fullNode?.powerRate);
    return {
      kind: 'hvac',
      name: str(cfg.name),
      version,
      mode: str(cfgFull.mode) ?? str(cfg.mode),
      fanSpeed: num(cfg.fan?.speed),
      compressorState: effectiveCompressorState(
        str(cfgFull.compressor?.state) ?? str(cfg.compressor?.state),
        powerRate
      ),
      compressorSpeed: num(cfg.compressor?.speed),
      temp: num(n.temperture),
      setpoint: setpoint && setpoint > 0 ? setpoint : undefined,
      humidity: num(n.humidity),
      targetHumidity: targetHumidity && targetHumidity > 0 ? targetHumidity : undefined,
      powerRate,
      powerTotal: num(n.powerTotal) ?? num(fullNode?.powerTotal),
      voltageMv: num(n.voltage),
      budgetEnabled: typeof cfg.budget?.enabled === 'boolean' ? cfg.budget.enabled : undefined,
      budgetLimit: num(cfg.budget?.limit),
      adminPinSet: typeof n.adminPinSet === 'boolean' ? n.adminPinSet : undefined,
      alarms: extractAlarms(n),
    };
  }

  return {
    kind: 'utility',
    name: str(cfg.name),
    version,
    temp: num(n.temperature),
    humidity: num(n.humidity),
    battery: num(n.battery),
    voltageMv: num(n.voltage),
    alarms: [],
  };
}
