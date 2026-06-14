/**
 * Global test setup. Runs once per test file before any test.
 *
 * Loads the protobuf definitions so decodePayload/extractDeviceName work in
 * unit and integration tests without each test wiring it up. initProtoDecoder
 * is idempotent, so calling it here is safe even when a test also triggers it.
 */
import { initProtoDecoder } from '../src/services/protoDecoder';

initProtoDecoder();
