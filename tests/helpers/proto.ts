/**
 * Test helper: encode protobuf payloads the way real devices send them.
 *
 * Tests assert on *decoded* behavior (e.g. the name a heartbeat carries), so
 * encoding fresh from the same .proto files the app loads keeps the fixtures
 * honest — if the schema changes, the fixtures change with it instead of
 * silently drifting from a hardcoded base64 blob.
 */
import * as protobuf from 'protobufjs';
import * as path from 'path';

let root: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (root) return root;
  const r = new protobuf.Root();
  r.loadSync(path.resolve(process.cwd(), 'bossmarine.proto'), { keepCase: false });
  r.loadSync(path.resolve(process.cwd(), 'ble.proto'), { keepCase: false });
  root = r;
  return r;
}

/** Encode an object as the named protobuf message and return base64 (the wire format the broker stores). */
export function encodeBase64(typeName: string, obj: Record<string, unknown>): string {
  const type = getRoot().lookupType(typeName);
  const err = type.verify(obj);
  if (err) throw new Error(`encode ${typeName}: ${err}`);
  const buf = type.encode(type.create(obj)).finish();
  return Buffer.from(buf).toString('base64');
}

/** A BM.Hvac heartbeat carrying a config name (config.name at the decoded root). */
export function hvacHeartbeat(name: string): string {
  return encodeBase64('BM.Hvac', {
    config: { name, mode: 1 },
    temperture: 72,
    humidity: 55,
    voltage: 12000,
  });
}

/** A BM.Utility heartbeat carrying a config name. */
export function utilityHeartbeat(name: string): string {
  return encodeBase64('BM.Utility', {
    config: { name, sleep: 30 },
    temperature: 68,
    humidity: 40,
    battery: 90,
    voltage: 3700,
  });
}

/** A heartbeat with no name set anywhere. */
export function namelessHeartbeat(): string {
  return encodeBase64('BM.Hvac', { temperture: 70, humidity: 50, voltage: 12000 });
}

/** A legacy BLE.Msg{deviceInfoRequest} status poll — the shape the mobile route drops. */
export function legacyDeviceInfoRequest(): string {
  return encodeBase64('BLE.Msg', {
    deviceInfoRequest: { mac: { addr: Buffer.from([1, 2, 3, 4, 5, 6]) } },
  });
}
