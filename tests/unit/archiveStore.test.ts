import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ArchiveStore,
  extractTelemetry,
  fingerprint,
  archiveEnabled,
  type ArchiveWriteInput,
} from '../../src/services/archiveStore';
import { decodePayload } from '../../src/services/protoDecoder';
import { hvacHeartbeat, wrappedHvacHeartbeat, utilityHeartbeat, legacyDeviceInfoRequest, encodeBase64 } from '../helpers/proto';

/** A BM.Hvac heartbeat with fixed temp/humidity/mode but configurable power. */
function hvacWithPower(powerRate: number, powerTotal: number): string {
  return encodeBase64('BM.Hvac', {
    config: { name: 'P', mode: 1 },
    temperture: 72,
    humidity: 55,
    voltage: 12000,
    powerRate,
    powerTotal,
  });
}

/**
 * Fake DynamoDBDocumentClient. `send` records every command and dispatches to
 * an optional per-command-type handler so a test can stage Query responses.
 * Handlers are keyed by constructor name (PutCommand / UpdateCommand /
 * QueryCommand).
 */
function fakeDoc(handlers: Record<string, (cmd: any) => any> = {}) {
  const sends: any[] = [];
  const doc = {
    sends,
    send: vi.fn(async (cmd: any) => {
      sends.push(cmd);
      const h = handlers[cmd.constructor.name];
      return h ? h(cmd) : {};
    }),
  };
  return doc as any;
}

const SAVED_ENABLED = process.env.ARCHIVE_ENABLED;

function input(over: Partial<ArchiveWriteInput> = {}): ArchiveWriteInput {
  return {
    controllerId: 101,
    ts: 1_781_000_000_000,
    streamId: '1781000000000-0',
    senderType: 'controller',
    senderIp: 'fw',
    payloadRaw: hvacHeartbeat('Cabin Air'),
    ...over,
  };
}

afterEach(() => {
  if (SAVED_ENABLED === undefined) delete process.env.ARCHIVE_ENABLED;
  else process.env.ARCHIVE_ENABLED = SAVED_ENABLED;
});

describe('extractTelemetry', () => {
  it('pulls numeric measures + state from a bare BM.Hvac heartbeat', () => {
    const t = extractTelemetry(decodePayload(hvacHeartbeat('Cabin Air')));
    expect(t?.kind).toBe('hvac');
    expect(t?.measures.temperatureF).toBe(72);
    expect(t?.measures.humidity).toBe(55);
    expect(t?.measures.voltageMv).toBe(12000);
  });

  it('finds the telemetry node nested inside a BLE.Msg wrapper', () => {
    const t = extractTelemetry(decodePayload(wrappedHvacHeartbeat('Cabin Air')));
    expect(t?.kind).toBe('hvac');
    expect(t?.measures.temperatureF).toBe(74);
    expect(t?.measures.fanSpeed).toBe(1);
    expect(t?.measures.compressorSpeed).toBe(3);
  });

  it('extracts utility measures including battery', () => {
    const t = extractTelemetry(decodePayload(utilityHeartbeat('Bilge')));
    expect(t?.kind).toBe('utility');
    expect(t?.measures.battery).toBe(90);
    expect(t?.measures.temperatureF).toBe(68);
  });

  it('returns null for a non-telemetry payload (command)', () => {
    expect(extractTelemetry(decodePayload(legacyDeviceInfoRequest()))).toBeNull();
    expect(extractTelemetry(null)).toBeNull();
  });
});

describe('fingerprint', () => {
  it('is stable for identical readings and differs when a measure changes', () => {
    const a = extractTelemetry(decodePayload(hvacHeartbeat('X')))!;
    const b = extractTelemetry(decodePayload(hvacHeartbeat('X')))!;
    expect(fingerprint(a)).toBe(fingerprint(b));

    const c = extractTelemetry(decodePayload(utilityHeartbeat('X')))!;
    expect(fingerprint(a)).not.toBe(fingerprint(c));
  });

  it('ignores the powerTotal accumulator but treats powerRate as a real change', () => {
    const base = extractTelemetry(decodePayload(hvacWithPower(67.5, 100)))!;
    // Same powerRate, higher accumulator -> same fingerprint (deduped).
    const accumulated = extractTelemetry(decodePayload(hvacWithPower(67.5, 250)))!;
    expect(fingerprint(base)).toBe(fingerprint(accumulated));
    // Different powerRate -> different fingerprint (a settings change).
    const rateChanged = extractTelemetry(decodePayload(hvacWithPower(80, 250)))!;
    expect(fingerprint(base)).not.toBe(fingerprint(rateChanged));
  });
});

describe('ArchiveStore.write — change-based dedup (FR-6)', () => {
  beforeEach(() => {
    process.env.ARCHIVE_ENABLED = 'true';
  });

  it('no-ops entirely when ARCHIVE_ENABLED is not "true"', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const doc = fakeDoc();
    await new ArchiveStore(doc).write(input());
    expect(doc.send).not.toHaveBeenCalled();
  });

  it('writes a PutItem change-point for the first heartbeat', async () => {
    // getDedup Query returns no prior item -> PutItem.
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    await new ArchiveStore(doc).write(input());
    const put = doc.sends.find((c: any) => c.constructor.name === 'PutCommand');
    expect(put).toBeTruthy();
    expect(put.input.Item.repeated).toBe(0);
    expect(put.input.Item.controllerId).toBe('101');
    expect(put.input.Item.measures.temperatureF).toBe(72);
    expect(put.input.Item.ttl).toBeGreaterThan(0);
  });

  it('bumps `repeated` instead of writing a new point when telemetry is unchanged', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ ts: 1_781_000_000_000 }));
    await store.write(input({ ts: 1_781_000_005_000 })); // +5s, identical payload

    const puts = doc.sends.filter((c: any) => c.constructor.name === 'PutCommand');
    const updates = doc.sends.filter((c: any) => c.constructor.name === 'UpdateCommand');
    expect(puts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].input.UpdateExpression).toMatch(/ADD repeated/);
    expect(updates[0].input.ExpressionAttributeValues[':ts']).toBe(1_781_000_005_000);
  });

  it('writes a new change-point when a measure changes', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ payloadRaw: hvacHeartbeat('A') }));
    await store.write(input({ ts: 1_781_000_005_000, payloadRaw: utilityHeartbeat('A') }));
    expect(doc.sends.filter((c: any) => c.constructor.name === 'PutCommand')).toHaveLength(2);
  });

  it('flags commsResumed when an unchanged heartbeat arrives after a long gap', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ ts: 1_781_000_000_000 }));
    await store.write(input({ ts: 1_781_000_000_000 + 120_000 })); // +2min > 60s gap
    const puts = doc.sends.filter((c: any) => c.constructor.name === 'PutCommand');
    expect(puts).toHaveLength(2);
    expect(puts[1].input.Item.commsResumed).toBe(true);
  });

  it('does not archive a non-telemetry payload', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    await new ArchiveStore(doc).write(input({ payloadRaw: legacyDeviceInfoRequest() }));
    expect(doc.sends.filter((c: any) => c.constructor.name !== 'QueryCommand')).toHaveLength(0);
  });

  it('swallows write errors (best-effort, FR-3)', async () => {
    const doc = fakeDoc({
      QueryCommand: () => ({ Items: [] }),
      PutCommand: () => {
        throw new Error('DynamoDB unavailable');
      },
    });
    await expect(new ArchiveStore(doc).write(input())).resolves.toBeUndefined();
  });

  it('latest-wins: a duplicate refreshes measures/payloadRaw/streamId to the newest reading', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ ts: 1_781_000_000_000, streamId: 'first-0' }));
    await store.write(input({ ts: 1_781_000_005_000, streamId: 'latest-0' }));

    const update = doc.sends.find((c: any) => c.constructor.name === 'UpdateCommand');
    const vals = update.input.ExpressionAttributeValues;
    expect(vals[':ts']).toBe(1_781_000_005_000); // lastTs = newest
    expect(vals[':sid']).toBe('latest-0'); // streamId refreshed to newest
    expect(update.input.UpdateExpression).toMatch(/SET lastTs = :ts, measures = :m/);
    // Key still targets the ORIGINAL change-point (first ts), not a new row.
    expect(update.input.Key.ts).toBe(1_781_000_000_000);
  });

  it('powerTotal-only movement is a duplicate (one Put, one Update) carrying the latest total', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ ts: 1_781_000_000_000, payloadRaw: hvacWithPower(67.5, 100) }));
    await store.write(input({ ts: 1_781_000_005_000, payloadRaw: hvacWithPower(67.5, 250) }));

    const puts = doc.sends.filter((c: any) => c.constructor.name === 'PutCommand');
    const updates = doc.sends.filter((c: any) => c.constructor.name === 'UpdateCommand');
    expect(puts).toHaveLength(1); // accumulator climbing alone did NOT spawn a new row
    expect(updates).toHaveLength(1);
    expect(updates[0].input.ExpressionAttributeValues[':m'].powerTotal).toBe(250); // latest total retained
  });

  it('a powerRate change DOES create a new change-point (machine settings changed)', async () => {
    const doc = fakeDoc({ QueryCommand: () => ({ Items: [] }) });
    const store = new ArchiveStore(doc);
    await store.write(input({ ts: 1_781_000_000_000, payloadRaw: hvacWithPower(67.5, 100) }));
    await store.write(input({ ts: 1_781_000_005_000, payloadRaw: hvacWithPower(80, 110) }));
    expect(doc.sends.filter((c: any) => c.constructor.name === 'PutCommand')).toHaveLength(2);
  });
});

describe('ArchiveStore.query — bucketing', () => {
  it('returns raw change-points directly under raw resolution', async () => {
    const items = [
      { controllerId: '101', ts: 1000, measures: { temperatureF: 70 }, repeated: 0, lastTs: 1000 },
      { controllerId: '101', ts: 2000, measures: { temperatureF: 72 }, repeated: 0, lastTs: 2000 },
    ];
    // First Query = carry-in (none), second = in-window items.
    let call = 0;
    const doc = fakeDoc({ QueryCommand: () => (call++ === 0 ? { Items: [] } : { Items: items }) });
    const res = await new ArchiveStore(doc).query(101, 500, 3000, 'raw');
    expect(res.resolution).toBe('raw');
    expect(res.points).toHaveLength(2);
    expect(res.points[0]).toMatchObject({ ts: 1000, temperatureF: 70 });
  });

  it('aggregates avg/min/max into time buckets at a coarse resolution', async () => {
    const items = [
      { controllerId: '101', ts: 0, measures: { temperatureF: 70 }, repeated: 0, lastTs: 0 },
      { controllerId: '101', ts: 30_000, measures: { temperatureF: 80 }, repeated: 0, lastTs: 30_000 },
    ];
    let call = 0;
    const doc = fakeDoc({ QueryCommand: () => (call++ === 0 ? { Items: [] } : { Items: items }) });
    const res = await new ArchiveStore(doc).query(101, 0, 60_000, '1m');
    expect(res.resolution).toBe('1m');
    // Both readings fall in the single 1-minute bucket [0, 60000).
    expect(res.points).toHaveLength(1);
    const tempAgg = res.points[0].temperatureF as { avg: number; min: number; max: number };
    expect(tempAgg.min).toBe(70);
    expect(tempAgg.max).toBe(80);
    expect(tempAgg.avg).toBe(75);
  });
});

describe('ArchiveStore.getRange', () => {
  it('reads newest-first with a limit and returns items chronologically', async () => {
    // DynamoDB returns these descending (ScanIndexForward false).
    const descending = [
      { controllerId: '1', ts: 3000, payloadRaw: 'c' },
      { controllerId: '1', ts: 2000, payloadRaw: 'b' },
      { controllerId: '1', ts: 1000, payloadRaw: 'a' },
    ];
    const doc = fakeDoc({ QueryCommand: () => ({ Items: descending }) });
    const out = await new ArchiveStore(doc).getRange(1, 0, 9999, 100);

    expect(out.map((i: any) => i.ts)).toEqual([1000, 2000, 3000]); // reversed to ascending
    const q = doc.sends.find((c: any) => c.constructor.name === 'QueryCommand');
    expect(q.input.ScanIndexForward).toBe(false);
    expect(q.input.Limit).toBe(100);
  });
});
