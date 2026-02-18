/**
 * Test script for protobuf controller ID validation
 * Creates actual protobuf messages to test the validation logic
 */

import * as protobuf from 'protobufjs';
import * as path from 'path';
import { validateControllerIdInProtobuf } from './src/protobufValidator';

async function testProtobufValidation() {
  console.log('Loading protobuf definitions...');
  
  // Use process.cwd() to find proto files
  const root = await protobuf.load([
    path.join(process.cwd(), 'ble.proto'),
    path.join(process.cwd(), 'bossmarine.proto')
  ]);

  console.log('\n=== Test 1: HvacConfig with controller_id = 0 (should be rejected) ===');
  const HvacConfig = root.lookupType('BM.HvacConfig');
  const hvacWithZero = HvacConfig.create({
    mode: 1, // COOL
    tempreature: 72,
    humidity: 50,
    controllerId: 0
  });
  const bufferZero = HvacConfig.encode(hvacWithZero).finish();
  const base64Zero = Buffer.from(bufferZero).toString('base64');
  console.log('Base64 payload:', base64Zero);
  
  const resultZero = await validateControllerIdInProtobuf(base64Zero);
  console.log('Validation result:', resultZero);
  console.log('Expected: valid=false, controllerId=0');
  console.log('Test 1:', resultZero.valid === false && resultZero.controllerId === 0 ? 'PASS ✓' : 'FAIL ✗');

  console.log('\n=== Test 2: HvacConfig with controller_id = 12345 (should be accepted) ===');
  const hvacWithId = HvacConfig.create({
    mode: 1, // COOL
    tempreature: 72,
    humidity: 50,
    controllerId: 12345
  });
  const bufferId = HvacConfig.encode(hvacWithId).finish();
  const base64Id = Buffer.from(bufferId).toString('base64');
  console.log('Base64 payload:', base64Id);
  
  const resultId = await validateControllerIdInProtobuf(base64Id);
  console.log('Validation result:', resultId);
  console.log('Expected: valid=true, controllerId=12345');
  console.log('Test 2:', resultId.valid === true && resultId.controllerId === 12345 ? 'PASS ✓' : 'FAIL ✗');

  console.log('\n=== Test 3: HvacConfig without controller_id (should be accepted) ===');
  const hvacWithoutId = HvacConfig.create({
    mode: 1, // COOL
    tempreature: 72,
    humidity: 50
  });
  const bufferNoId = HvacConfig.encode(hvacWithoutId).finish();
  const base64NoId = Buffer.from(bufferNoId).toString('base64');
  console.log('Base64 payload:', base64NoId);
  
  const resultNoId = await validateControllerIdInProtobuf(base64NoId);
  console.log('Validation result:', resultNoId);
  console.log('Expected: valid=true, controllerId=null');
  console.log('Test 3:', resultNoId.valid === true && resultNoId.controllerId === null ? 'PASS ✓' : 'FAIL ✗');

  console.log('\n=== Test 4: BLE.Msg with SyncDevice2Controller containing controller_id = 0 (should be rejected) ===');
  const BleMsg = root.lookupType('BLE.Msg');
  const Mac = root.lookupType('BM.Mac');
  
  const mac = Mac.create({
    addr: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
  });
  
  const SyncDevice2Controller = root.lookupType('BLE.SyncDevice2Controller');
  const Hvac = root.lookupType('BM.Hvac');
  
  const hvac = Hvac.create({
    config: {
      mode: 1,
      tempreature: 72,
      humidity: 50,
      controllerId: 0
    },
    temperture: 72,
    humidity: 50
  });
  
  const sync = SyncDevice2Controller.create({
    version: '1.0',
    hvac: hvac
  });
  
  const bleMsg = BleMsg.create({
    mac: mac,
    syncDevice2Controller: sync
  });
  
  const bufferBle = BleMsg.encode(bleMsg).finish();
  const base64Ble = Buffer.from(bufferBle).toString('base64');
  console.log('Base64 payload:', base64Ble);
  
  const resultBle = await validateControllerIdInProtobuf(base64Ble);
  console.log('Validation result:', resultBle);
  console.log('Expected: valid=false, controllerId=0');
  console.log('Test 4:', resultBle.valid === false && resultBle.controllerId === 0 ? 'PASS ✓' : 'FAIL ✗');

  console.log('\n=== Test 5: BLE.Msg with SyncDevice2Controller containing controller_id = 99999 (should be accepted) ===');
  const hvac2 = Hvac.create({
    config: {
      mode: 1,
      tempreature: 72,
      humidity: 50,
      controllerId: 99999
    },
    temperture: 72,
    humidity: 50
  });
  
  const sync2 = SyncDevice2Controller.create({
    version: '1.0',
    hvac: hvac2
  });
  
  const bleMsg2 = BleMsg.create({
    mac: mac,
    syncDevice2Controller: sync2
  });
  
  const bufferBle2 = BleMsg.encode(bleMsg2).finish();
  const base64Ble2 = Buffer.from(bufferBle2).toString('base64');
  console.log('Base64 payload:', base64Ble2);
  
  const resultBle2 = await validateControllerIdInProtobuf(base64Ble2);
  console.log('Validation result:', resultBle2);
  console.log('Expected: valid=true, controllerId=99999');
  console.log('Test 5:', resultBle2.valid === true && resultBle2.controllerId === 99999 ? 'PASS ✓' : 'FAIL ✗');

  console.log('\n=== Summary ===');
  console.log('All protobuf validation tests completed.');
}

testProtobufValidation().catch(console.error);
