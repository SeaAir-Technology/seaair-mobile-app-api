import { describe, it, expect } from 'vitest';
import {
  decodePayload,
  extractDeviceName,
  extractFirmwareVersion,
  getByPath,
  parseFilterParam,
  evaluateFilter,
  evaluateFilters,
  DecodedPayload,
} from '../../src/services/protoDecoder';
import { hvacHeartbeat, utilityHeartbeat, namelessHeartbeat, wrappedHvacHeartbeat } from '../helpers/proto';

function decoded(data: Record<string, unknown>): DecodedPayload {
  return { typeName: 'Test', data };
}

describe('extractDeviceName', () => {
  it('reads a name nested under hvac.config', () => {
    expect(extractDeviceName(decoded({ hvac: { config: { name: 'Salon HVAC' } } }))).toBe('Salon HVAC');
  });

  it('reads a name nested under utility.config', () => {
    expect(extractDeviceName(decoded({ utility: { config: { name: 'Bilge' } } }))).toBe('Bilge');
  });

  it('reads a name from config at the root (bare Hvac/Utility decode)', () => {
    expect(extractDeviceName(decoded({ config: { name: 'Cabin' } }))).toBe('Cabin');
  });

  it('reads a name at the top level', () => {
    expect(extractDeviceName(decoded({ name: 'Top' }))).toBe('Top');
  });

  it('trims surrounding whitespace', () => {
    expect(extractDeviceName(decoded({ config: { name: '  Padded  ' } }))).toBe('Padded');
  });

  it('returns undefined for a null payload', () => {
    expect(extractDeviceName(null)).toBeUndefined();
  });

  it('returns undefined when no name field is present', () => {
    expect(extractDeviceName(decoded({ hvac: { temperture: 72 } }))).toBeUndefined();
  });

  it('treats an empty / whitespace-only name as absent', () => {
    expect(extractDeviceName(decoded({ config: { name: '' } }))).toBeUndefined();
    expect(extractDeviceName(decoded({ config: { name: '   ' } }))).toBeUndefined();
  });

  it('prefers the hvac path over a generic top-level name', () => {
    expect(extractDeviceName(decoded({ hvac: { config: { name: 'Specific' } }, name: 'Generic' }))).toBe('Specific');
  });

  it('finds a name nested under a BLE.Msg wrapper (real heartbeat shape)', () => {
    // The shape that regressed in production: name buried two wrappers deep.
    expect(
      extractDeviceName(decoded({ syncDevice2Controller: { hvac: { config: { name: 'Test' } } } })),
    ).toBe('Test');
    expect(
      extractDeviceName(decoded({ deviceInfoResponse: { utility: { config: { name: 'Bilge' } } } })),
    ).toBe('Bilge');
  });
});

describe('decodePayload (end-to-end with real protos)', () => {
  it('decodes an HVAC heartbeat and surfaces its name', () => {
    const result = decodePayload(hvacHeartbeat('Cabin Air'));
    expect(result).not.toBeNull();
    expect(extractDeviceName(result)).toBe('Cabin Air');
  });

  it('decodes a Utility heartbeat and surfaces its name', () => {
    const result = decodePayload(utilityHeartbeat('Bilge Sensor'));
    expect(extractDeviceName(result)).toBe('Bilge Sensor');
  });

  it('decodes a wire-realistic BLE.Msg-wrapped heartbeat and surfaces its name', () => {
    const result = decodePayload(wrappedHvacHeartbeat('Salon HVAC'));
    expect(result?.typeName).toBe('BLE.Msg');
    expect(extractDeviceName(result)).toBe('Salon HVAC');
  });

  it('decodes a nameless heartbeat with no name', () => {
    expect(extractDeviceName(decodePayload(namelessHeartbeat()))).toBeUndefined();
  });

  it('returns null for empty / undecodable input', () => {
    expect(decodePayload('')).toBeNull();
    expect(decodePayload('!!!not base64!!!')).toBeNull();
  });
});

describe('extractFirmwareVersion', () => {
  it('reads the version from a BLE.Msg-wrapped sync heartbeat', () => {
    const result = decodePayload(wrappedHvacHeartbeat('Salon HVAC'));
    expect(extractFirmwareVersion(result)).toBe('1.2.3');
  });

  it('reads a root-level version from a bare sync decode', () => {
    expect(
      extractFirmwareVersion(decoded({ version: '2.0.1', hvac: {} }))
    ).toBe('2.0.1');
  });

  it('returns undefined when no version is present', () => {
    expect(extractFirmwareVersion(decodePayload(utilityHeartbeat('Bilge')))).toBeUndefined();
    expect(extractFirmwareVersion(null)).toBeUndefined();
  });
});

describe('getByPath', () => {
  it('walks a dot path', () => {
    expect(getByPath({ a: { b: { c: 5 } } }, 'a.b.c')).toBe(5);
  });
  it('returns undefined for a missing path', () => {
    expect(getByPath({ a: {} }, 'a.b.c')).toBeUndefined();
  });
  it('returns undefined for null object or empty path', () => {
    expect(getByPath(null, 'a')).toBeUndefined();
    expect(getByPath({ a: 1 }, '')).toBeUndefined();
  });
});

describe('parseFilterParam', () => {
  it('parses bare equality', () => {
    expect(parseFilterParam('hvac.mode=cool')).toEqual({ path: 'hvac.mode', op: 'eq', value: 'cool' });
  });
  it('parses an op with a numeric value', () => {
    expect(parseFilterParam('hvac.temperature=gt:70')).toEqual({ path: 'hvac.temperature', op: 'gt', value: 70 });
  });
  it('parses bare exists', () => {
    expect(parseFilterParam('hvac.fault=exists')).toEqual({ path: 'hvac.fault', op: 'exists', value: true });
  });
  it('parses exists:false', () => {
    expect(parseFilterParam('hvac.fault=exists:false')).toEqual({ path: 'hvac.fault', op: 'exists', value: false });
  });
  it('keeps contains values as strings even when numeric', () => {
    expect(parseFilterParam('name=contains:12')).toEqual({ path: 'name', op: 'contains', value: '12' });
  });
  it('returns null when there is no = sign', () => {
    expect(parseFilterParam('justtext')).toBeNull();
  });
});

describe('evaluateFilter', () => {
  const d = decoded({ hvac: { mode: 'cool', temperature: 72, name: 'Galley' } });

  it('eq matches', () => {
    expect(evaluateFilter(d, { path: 'hvac.mode', op: 'eq', value: 'cool' })).toBe(true);
    expect(evaluateFilter(d, { path: 'hvac.mode', op: 'eq', value: 'heat' })).toBe(false);
  });
  it('gt / lt compare numerically', () => {
    expect(evaluateFilter(d, { path: 'hvac.temperature', op: 'gt', value: 70 })).toBe(true);
    expect(evaluateFilter(d, { path: 'hvac.temperature', op: 'lt', value: 70 })).toBe(false);
  });
  it('contains is case-insensitive substring', () => {
    expect(evaluateFilter(d, { path: 'hvac.name', op: 'contains', value: 'gall' })).toBe(true);
  });
  it('exists checks presence', () => {
    expect(evaluateFilter(d, { path: 'hvac.name', op: 'exists', value: true })).toBe(true);
    expect(evaluateFilter(d, { path: 'hvac.missing', op: 'exists', value: false })).toBe(true);
  });
  it('a null decode only satisfies exists:false', () => {
    expect(evaluateFilter(null, { path: 'hvac.mode', op: 'exists', value: false })).toBe(true);
    expect(evaluateFilter(null, { path: 'hvac.mode', op: 'eq', value: 'cool' })).toBe(false);
  });
  it('AND-combines via evaluateFilters', () => {
    expect(
      evaluateFilters(d, [
        { path: 'hvac.mode', op: 'eq', value: 'cool' },
        { path: 'hvac.temperature', op: 'gte', value: 72 },
      ]),
    ).toBe(true);
    expect(
      evaluateFilters(d, [
        { path: 'hvac.mode', op: 'eq', value: 'cool' },
        { path: 'hvac.temperature', op: 'gt', value: 100 },
      ]),
    ).toBe(false);
  });
});
