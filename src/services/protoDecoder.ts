/**
 * Protobuf decoder + filter engine for stacked dashboard searching.
 *
 * The mobile + firmware exchange opaque base64 protobuf payloads through
 * Redis Streams. The dashboard needs to filter on the *contents* of those
 * payloads after the cheap controllerId pre-filter. This module:
 *
 *   1. Loads bossmarine.proto and ble.proto at boot
 *   2. Tries each known message type to decode an opaque payload
 *   3. Returns the decoded object as a plain JSON-friendly tree
 *   4. Evaluates predicates against decoded fields (dot-paths)
 *
 * Predicates use the form { path: 'hvac.temperature', op: 'gt', value: 70 }
 * and stack via AND. The dashboard frontend builds these from the UI.
 */

import * as protobuf from 'protobufjs';
import * as path from 'path';

const PROTO_FILES = ['bossmarine.proto', 'ble.proto'];

let root: protobuf.Root | null = null;
let candidateTypes: protobuf.Type[] = [];

export function initProtoDecoder(): void {
  if (root) return;
  const r = new protobuf.Root();
  for (const file of PROTO_FILES) {
    try {
      r.loadSync(path.resolve(process.cwd(), file), { keepCase: false });
      console.log(`[ProtoDecoder] Loaded ${file}`);
    } catch (err: any) {
      console.warn(`[ProtoDecoder] Could not load ${file}: ${err.message}`);
    }
  }
  // Walk the namespace and collect every concrete message Type.
  const types: protobuf.Type[] = [];
  function visit(ns: protobuf.NamespaceBase): void {
    for (const child of ns.nestedArray) {
      if (child instanceof protobuf.Type) types.push(child);
      if ((child as any).nestedArray) visit(child as protobuf.NamespaceBase);
    }
  }
  visit(r);
  root = r;
  candidateTypes = types;
  console.log(`[ProtoDecoder] ${types.length} candidate message types loaded`);
}

export interface DecodedPayload {
  typeName: string;
  data: Record<string, any>;
}

/**
 * Try each message type in turn until one decodes cleanly. Returns null if
 * nothing decodes (e.g. corrupted or unknown payload).
 *
 * Caveat: protobuf has no self-describing tag, so misdecodes are possible.
 * We score by how many fields populated and pick the best match.
 */
export function decodePayload(base64Payload: string): DecodedPayload | null {
  if (!root) initProtoDecoder();
  if (!base64Payload || candidateTypes.length === 0) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(base64Payload, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  let bestMatch: DecodedPayload | null = null;
  let bestScore = -1;

  for (const type of candidateTypes) {
    try {
      const decoded = type.decode(buf);
      const obj = type.toObject(decoded, { defaults: false, longs: Number, enums: String, bytes: String });
      const score = scoreDecoded(obj);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { typeName: type.fullName.replace(/^\./, ''), data: obj };
      }
    } catch {
      // Wrong type, ignore
    }
  }

  // Demand at least one populated field to count as a real match
  return bestScore > 0 ? bestMatch : null;
}

function scoreDecoded(obj: any): number {
  if (obj === null || obj === undefined) return 0;
  if (typeof obj !== 'object') return 1;
  let score = 0;
  for (const v of Object.values(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') score += 1 + scoreDecoded(v);
    else score += 1;
  }
  return score;
}

/**
 * Pull a human-readable device name out of a decoded heartbeat, if present.
 *
 * The name lives on the device config (HvacConfig.name / UtilityConfig.name),
 * but how deeply it nests depends on which message type best-matched during
 * decode. Real firmware heartbeats decode as a BLE.Msg wrapper, so the config
 * sits at e.g. `syncDevice2Controller.hvac.config.name`; a bare Hvac/Utility
 * decodes with `config.name` at the root. Rather than enumerate every wrapper
 * field, we walk the tree for the first object carrying a `config.name`. This
 * is precise because `name` only appears on HvacConfig/UtilityConfig in the
 * schema. We fall back to a top-level `name` for a bare HvacConfig decode.
 */
function findConfigName(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  const cfg = (value as Record<string, any>).config;
  if (cfg && typeof cfg === 'object' && typeof cfg.name === 'string' && cfg.name.trim() !== '') {
    return cfg.name.trim();
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const found = findConfigName(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function extractDeviceName(decoded: DecodedPayload | null): string | undefined {
  if (!decoded) return undefined;
  const fromConfig = findConfigName(decoded.data);
  if (fromConfig) return fromConfig;
  // Bare HvacConfig/UtilityConfig decode: name sits at the root.
  const top = (decoded.data as Record<string, any>)?.name;
  if (typeof top === 'string' && top.trim() !== '') return top.trim();
  return undefined;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';

export interface PayloadFilter {
  path: string;            // dot-path into decoded object, e.g. "hvac.mode"
  op: FilterOp;
  value?: string | number | boolean;
}

export function getByPath(obj: any, dotPath: string): any {
  if (!obj || !dotPath) return undefined;
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function evaluateFilter(decoded: DecodedPayload | null, filter: PayloadFilter): boolean {
  if (!decoded) return filter.op === 'exists' && filter.value === false;
  const actual = getByPath(decoded.data, filter.path);
  switch (filter.op) {
    case 'exists':
      return filter.value === false ? actual === undefined : actual !== undefined;
    case 'eq':
      return String(actual) === String(filter.value);
    case 'ne':
      return String(actual) !== String(filter.value);
    case 'gt':
      return typeof actual === 'number' && typeof filter.value === 'number' && actual > filter.value;
    case 'gte':
      return typeof actual === 'number' && typeof filter.value === 'number' && actual >= filter.value;
    case 'lt':
      return typeof actual === 'number' && typeof filter.value === 'number' && actual < filter.value;
    case 'lte':
      return typeof actual === 'number' && typeof filter.value === 'number' && actual <= filter.value;
    case 'contains':
      return typeof actual === 'string' &&
        typeof filter.value === 'string' &&
        actual.toLowerCase().includes(filter.value.toLowerCase());
    default:
      return false;
  }
}

export function evaluateFilters(decoded: DecodedPayload | null, filters: PayloadFilter[]): boolean {
  for (const f of filters) {
    if (!evaluateFilter(decoded, f)) return false;
  }
  return true;
}

/**
 * Best-effort conversion of a "field=op:value" or "field=value" query string
 * fragment into a PayloadFilter. Used by the dashboard route to translate
 * URL query params.
 *
 * Examples:
 *   "hvac.mode=cool"            -> { path: 'hvac.mode', op: 'eq', value: 'cool' }
 *   "hvac.temperature=gt:70"    -> { path: 'hvac.temperature', op: 'gt', value: 70 }
 *   "hvac.fault=exists"         -> { path: 'hvac.fault', op: 'exists', value: true }
 */
export function parseFilterParam(param: string): PayloadFilter | null {
  const eq = param.indexOf('=');
  if (eq < 0) return null;
  const filterPath = param.slice(0, eq).trim();
  const rhs = param.slice(eq + 1).trim();
  if (!filterPath) return null;

  const colon = rhs.indexOf(':');
  let op: FilterOp = 'eq';
  let valStr = rhs;
  if (colon > 0) {
    const candidate = rhs.slice(0, colon).toLowerCase() as FilterOp;
    if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'].includes(candidate)) {
      op = candidate;
      valStr = rhs.slice(colon + 1);
    }
  } else if (rhs === 'exists') {
    return { path: filterPath, op: 'exists', value: true };
  }

  let value: string | number | boolean = valStr;
  if (op !== 'contains' && op !== 'exists') {
    const asNum = Number(valStr);
    if (!Number.isNaN(asNum) && valStr !== '') value = asNum;
    else if (valStr === 'true') value = true;
    else if (valStr === 'false') value = false;
  }
  if (op === 'exists') value = valStr !== 'false';

  return { path: filterPath, op, value };
}
