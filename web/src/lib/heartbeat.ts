// Turn a decoded heartbeat payload into a small set of user-readable stats for
// the Current State summary. The decoder returns a JSON tree (a BLE.Msg wrapper
// around an HVAC/Utility device, or a bare device), so — like the backend's
// telemetry extraction — we walk the tree for the first node that looks like
// device telemetry and pull the known fields off it. Anything missing is simply
// omitted, so partial/unknown payloads degrade gracefully.

import type { DecodedPayload } from './types';

export interface StatItem {
  label: string;
  value: string;
  tone?: 'normal' | 'good' | 'warn' | 'alarm';
}

export interface HeartbeatSummary {
  kind: 'hvac' | 'utility';
  name?: string;
  stats: StatItem[];
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

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function summarizeHeartbeat(decoded: DecodedPayload | null): HeartbeatSummary | null {
  if (!decoded) return null;
  const found = findTelemetry(decoded.data);
  if (!found) return null;

  const n = found.node;
  const cfg = n.config && typeof n.config === 'object' ? n.config : {};
  const name = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : undefined;
  const stats: StatItem[] = [];
  const alarms: string[] = [];
  const push = (label: string, value: string | undefined, tone?: StatItem['tone']): void => {
    if (value !== undefined && value !== '') stats.push({ label, value, tone });
  };

  if (found.kind === 'hvac') {
    const mode = typeof cfg.mode === 'string' ? titleCase(cfg.mode) : undefined;
    push('Mode', mode);
    const cur = num(n.temperture);
    push('Temperature', cur !== undefined ? `${cur}°F` : undefined);
    const setpoint = num(cfg.tempreature); // setpoint (sic in proto); 0 = unset
    push('Setpoint', setpoint && setpoint > 0 ? `${setpoint}°F` : undefined);
    push('Humidity', num(n.humidity) !== undefined ? `${num(n.humidity)}%` : undefined);
    const fan = num(cfg.fan?.speed);
    push('Fan speed', fan !== undefined ? String(fan) : undefined);
    const compSpeed = num(cfg.compressor?.speed);
    const compState = typeof cfg.compressor?.state === 'string' ? titleCase(cfg.compressor.state) : undefined;
    if (compState || compSpeed !== undefined) {
      const label = compState
        ? `${compState}${compSpeed !== undefined ? ` (${compSpeed})` : ''}`
        : String(compSpeed);
      push('Compressor', label);
    }
    const rate = num(n.powerRate);
    push('Power rate', rate !== undefined ? rate.toFixed(1) : undefined);
    const total = num(n.powerTotal);
    push('Power total', total !== undefined ? total.toFixed(1) : undefined);
    const mv = num(n.voltage);
    push('Voltage', mv !== undefined ? `${(mv / 1000).toFixed(2)} V` : undefined);
    if (n.high_pressure === true) alarms.push('High pressure');
    if (n.low_pressure === true) alarms.push('Low pressure');
  } else {
    push('Temperature', num(n.temperature) !== undefined ? `${num(n.temperature)}°F` : undefined);
    push('Humidity', num(n.humidity) !== undefined ? `${num(n.humidity)}%` : undefined);
    const batt = num(n.battery);
    push('Battery', batt !== undefined ? `${batt}%` : undefined, batt !== undefined && batt < 20 ? 'warn' : 'good');
    const mv = num(n.voltage);
    push('Voltage', mv !== undefined ? `${(mv / 1000).toFixed(2)} V` : undefined);
  }

  return { kind: found.kind, name, stats, alarms };
}
