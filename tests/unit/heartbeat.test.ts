import { describe, it, expect } from 'vitest';
import { extractCockpit, formatVoltage } from '../../web/src/lib/heartbeat';
import { decodePayload } from '../../src/services/protoDecoder';
import { encodeBase64 } from '../helpers/proto';

/**
 * Guards the Current State cockpit. The alarm chips were silently broken for
 * months because the summary read snake_case field names (`n.high_pressure`)
 * while the decoder emits camelCase — the chips never rendered and no test
 * caught it. Every case here goes through the real proto encode/decode
 * round-trip so a schema or casing regression fails loudly.
 */

function hvac(fields: Record<string, unknown>, cfg: Record<string, unknown> = {}): string {
  return encodeBase64('BM.Hvac', {
    config: { name: 'Chip Test', mode: 1, ...cfg },
    temperture: 72,
    humidity: 55,
    ...fields,
  });
}

describe('extractCockpit alarms', () => {
  it('reports no alarms on a healthy heartbeat', () => {
    const c = extractCockpit(decodePayload(hvac({})));
    expect(c?.alarms).toEqual([]);
  });

  it('reports each real-time alarm state', () => {
    const c = extractCockpit(
      decodePayload(
        hvac({
          compressorShutdown: true,
          lowPressure: true,
          lowVoltage: true,
          highVoltage: true,
        })
      )
    );
    expect(c?.alarms).toEqual([
      'Compressor shutdown',
      'Low pressure',
      'Low voltage',
      'High voltage',
    ]);
  });

  it('reports each latched alarm even without a real-time event', () => {
    const c = extractCockpit(
      decodePayload(
        hvac(
          {},
          {
            compressorShutdownAlarm: true,
            lowPressureAlarm: true,
            lowVoltageAlarm: true,
            highVoltageAlarm: true,
          }
        )
      )
    );
    expect(c?.alarms).toEqual([
      'Compressor shutdown',
      'Low pressure',
      'Low voltage',
      'High voltage',
    ]);
  });

  it('reports one entry per alarm when real-time and latched are both set', () => {
    const c = extractCockpit(
      decodePayload(hvac({ lowVoltage: true }, { lowVoltageAlarm: true }))
    );
    expect(c?.alarms).toEqual(['Low voltage']);
  });
});

describe('extractCockpit fields', () => {
  it('pulls run state, environment, and power off an hvac heartbeat', () => {
    const c = extractCockpit(
      decodePayload(
        hvac(
          { voltage: 14184, powerRate: 4.25, powerTotal: 128.5 },
          {
            tempreature: 68,
            humidity: 60,
            fan: { speed: 3 },
            compressor: { speed: 5, state: 1 },
          }
        )
      )
    );
    expect(c?.kind).toBe('hvac');
    expect(c?.name).toBe('Chip Test');
    expect(c?.mode).toBe('COOL');
    expect(c?.temp).toBe(72);
    expect(c?.setpoint).toBe(68);
    expect(c?.humidity).toBe(55);
    expect(c?.targetHumidity).toBe(60);
    expect(c?.fanSpeed).toBe(3);
    expect(c?.compressorSpeed).toBe(5);
    expect(c?.compressorState).toBe('OFF'); // enum: ON=0, OFF=1
    expect(c?.voltageMv).toBe(14184);
    expect(c?.powerRate).toBeCloseTo(4.25);
    expect(c?.powerTotal).toBeCloseTo(128.5);
  });

  it('treats a zero setpoint as unset', () => {
    const c = extractCockpit(decodePayload(hvac({}, { tempreature: 0 })));
    expect(c?.setpoint).toBeUndefined();
  });

  it('reads the firmware version off the sync wrapper', () => {
    const wrapped = encodeBase64('BLE.Msg', {
      syncDevice2Controller: {
        version: '3.1',
        hvac: { config: { name: 'Wrapped' }, temperture: 70 },
      },
    });
    const c = extractCockpit(decodePayload(wrapped));
    expect(c?.version).toBe('3.1');
    expect(c?.temp).toBe(70);
  });

  it('leaves version unset on a bare device payload', () => {
    const c = extractCockpit(decodePayload(hvac({})));
    expect(c?.version).toBeUndefined();
  });
});

describe('extractCockpit zero-valued enums', () => {
  it('reports STANDBY mode via the defaults-aware decode', () => {
    // mode 0 = STANDBY is omitted from the wire by proto3; it must come
    // through so the cockpit shows Standby instead of a dash or stale mode
    const c = extractCockpit(decodePayload(hvac({}, { mode: 0 })));
    expect(c?.mode).toBe('STANDBY');
  });

  it('reports compressor ON via the defaults-aware decode when drawing', () => {
    const c = extractCockpit(
      decodePayload(hvac({ powerRate: 33.5 }, { compressor: { speed: 4, state: 0 } }))
    );
    expect(c?.compressorState).toBe('ON'); // enum: ON=0
    expect(c?.compressorSpeed).toBe(4);
  });

  it('reads a wire-omitted powerRate as a real zero via the defaults view', () => {
    const c = extractCockpit(decodePayload(hvac({}, { mode: 0 })));
    expect(c?.powerRate).toBe(0);
  });
});

describe('effectiveCompressorState (pre-v3.2 firmware reports the config flag)', () => {
  it('overrides a reported "Off" when the machine is clearly drawing', () => {
    // The pre-v3.2 lie seen on HVAC-35e390: config flag OFF, 54.1A on the wire
    const c = extractCockpit(
      decodePayload(hvac({ powerRate: 54.1 }, { compressor: { speed: 3, state: 1 } }))
    );
    expect(c?.compressorState).toBe('ON');
  });

  it('overrides a reported "On" when nothing is drawing', () => {
    const c = extractCockpit(
      decodePayload(hvac({}, { compressor: { speed: 3, state: 0 } }))
    );
    // rate resolves to 0 via the defaults view -> not running
    expect(c?.compressorState).toBe('OFF');
  });

  it('keeps fan-only draw below the threshold reading as off', () => {
    const c = extractCockpit(
      decodePayload(hvac({ powerRate: 5.5 }, { compressor: { speed: 3, state: 1 } }))
    );
    expect(c?.compressorState).toBe('OFF');
  });
});

describe('formatVoltage', () => {
  it('formats millivolts in volts', () => {
    expect(formatVoltage(14184)).toBe('14.18 V');
  });
});
