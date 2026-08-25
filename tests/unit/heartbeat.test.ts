import { describe, it, expect } from 'vitest';
import { summarizeHeartbeat } from '../../web/src/lib/heartbeat';
import { decodePayload } from '../../src/services/protoDecoder';
import { encodeBase64 } from '../helpers/proto';

/**
 * Guards the Current State alarm chips. These were silently broken for months
 * because the summary read snake_case field names (`n.high_pressure`) while
 * the decoder emits camelCase — the chips never rendered and no test caught
 * it. Every case here goes through the real proto encode/decode round-trip so
 * a schema or casing regression fails loudly.
 */

function hvac(fields: Record<string, unknown>, cfg: Record<string, unknown> = {}): string {
  return encodeBase64('BM.Hvac', {
    config: { name: 'Chip Test', mode: 1, ...cfg },
    temperture: 72,
    humidity: 55,
    ...fields,
  });
}

describe('summarizeHeartbeat alarm chips', () => {
  it('renders no chips on a healthy heartbeat', () => {
    const s = summarizeHeartbeat(decodePayload(hvac({})));
    expect(s?.alarms).toEqual([]);
  });

  it('renders a chip for each real-time alarm state', () => {
    const s = summarizeHeartbeat(
      decodePayload(
        hvac({
          compressorShutdown: true,
          lowPressure: true,
          lowVoltage: true,
          highVoltage: true,
        })
      )
    );
    expect(s?.alarms).toEqual([
      'Compressor shutdown',
      'Low pressure',
      'Low voltage',
      'High voltage',
    ]);
  });

  it('renders a chip for each latched alarm even without a real-time event', () => {
    const s = summarizeHeartbeat(
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
    expect(s?.alarms).toEqual([
      'Compressor shutdown',
      'Low pressure',
      'Low voltage',
      'High voltage',
    ]);
  });

  it('renders one chip per alarm when real-time and latched are both set', () => {
    const s = summarizeHeartbeat(
      decodePayload(hvac({ lowVoltage: true }, { lowVoltageAlarm: true }))
    );
    expect(s?.alarms).toEqual(['Low voltage']);
  });

  it('formats the bus voltage stat in volts', () => {
    const s = summarizeHeartbeat(decodePayload(hvac({ voltage: 14184 })));
    const volt = s?.stats.find((x) => x.label === 'Voltage');
    expect(volt?.value).toBe('14.18 V');
  });
});
