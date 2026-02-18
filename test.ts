/**
 * Basic tests for SeaAir Mobile App API
 * Run with: npm test
 */

import http from 'http';

const API_BASE = 'http://localhost:3000';
let testCount = 0;
let passCount = 0;
let failCount = 0;

interface ApiResponse {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

// Helper function to make HTTP requests
function makeRequest(method: string, path: string, body: any = null, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode || 0, body: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode || 0, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

// Test helper
function assert(condition: boolean, message: string): void {
  testCount++;
  if (condition) {
    console.log(`✓ ${message}`);
    passCount++;
  } else {
    console.log(`✗ ${message}`);
    failCount++;
  }
}

async function runTests(): Promise<void> {
  console.log('Starting API tests...\n');

  try {
    // Test 1: Health check
    console.log('Test 1: Health Check');
    const health = await makeRequest('GET', '/health');
    assert(health.status === 200, 'Health endpoint returns 200');
    assert(health.body.status === 'healthy', 'Health status is healthy');
    assert(typeof health.body.queues === 'object', 'Health includes queue stats');
    console.log('');

    // Test 2: Detailed health check (empty queues)
    console.log('Test 2: Detailed Health Check (empty queues)');
    const healthDetail1 = await makeRequest('GET', '/health-detail');
    assert(healthDetail1.status === 200, 'Health-detail endpoint returns 200');
    assert(healthDetail1.body.status === 'healthy', 'Health-detail status is healthy');
    assert(typeof healthDetail1.body.queues === 'object', 'Health-detail includes queue stats');
    assert(typeof healthDetail1.body.queueContents === 'object', 'Health-detail includes queue contents');
    assert(typeof healthDetail1.body.queueContents.mobileAppQueue === 'object', 'Mobile app queue is present');
    assert(typeof healthDetail1.body.queueContents.controllerQueue === 'object', 'Controller queue is present');
    console.log('');

    // Test 3: Generate JWT token
    console.log('Test 3: Generate JWT Token');
    const tokenRes = await makeRequest('POST', '/test/generate-token', { userId: 'test-user-1' });
    assert(tokenRes.status === 200, 'Token generation returns 200');
    assert(tokenRes.body.token, 'Token is present in response');
    const token = tokenRes.body.token;
    console.log('');

    // Test 4: Controller heartbeat
    console.log('Test 4: Controller Heartbeat');
    const heartbeat = await makeRequest('POST', '/controller/heartbeat', {
      controllerId: 1,
      protobufPayload: 'dGVzdC1oZWFydGJlYXQ='
    });
    assert(heartbeat.status === 200, 'Heartbeat returns 200');
    assert(heartbeat.body.success === true, 'Heartbeat is successful');
    assert(heartbeat.body.controllerId === 1, 'Controller ID matches');
    console.log('');

    // Test 5: Detailed health check (with controller heartbeat)
    console.log('Test 5: Detailed Health Check (with data)');
    const healthDetail2 = await makeRequest('GET', '/health-detail');
    assert(healthDetail2.status === 200, 'Health-detail endpoint returns 200');
    assert(healthDetail2.body.queueContents.controllerQueue['1'], 'Controller 1 heartbeat is in queue');
    assert(healthDetail2.body.queueContents.controllerQueue['1'].protobufPayload === 'dGVzdC1oZWFydGJlYXQ=', 'Heartbeat payload matches');
    console.log('');

    // Test 6: Mobile app message without JWT (should fail)
    console.log('Test 6: Mobile Message Without JWT (should fail)');
    const noAuth = await makeRequest('POST', '/mobile/message', {
      controllerId: 1,
      protobufPayload: 'dGVzdC1tZXNzYWdl'
    });
    assert(noAuth.status === 401, 'No JWT returns 401');
    assert(noAuth.body.error, 'Error message is present');
    console.log('');

    // Test 7: Mobile app message with JWT
    console.log('Test 7: Mobile Message With JWT');
    const mobileMsg = await makeRequest('POST', '/mobile/message', {
      controllerId: 1,
      protobufPayload: 'dGVzdC1tb2JpbGUtbWVzc2FnZQ=='
    }, {
      'Authorization': `Bearer ${token}`
    });
    assert(mobileMsg.status === 200, 'Mobile message returns 200');
    assert(mobileMsg.body.success === true, 'Message queued successfully');
    console.log('');

    // Test 8: Controller retrieves message
    console.log('Test 8: Controller Retrieves Message');
    const retrieveMsg = await makeRequest('GET', '/controller/messages/1');
    assert(retrieveMsg.status === 200, 'Message retrieval returns 200');
    assert(retrieveMsg.body.success === true, 'Retrieval is successful');
    assert(retrieveMsg.body.message.protobufPayload === 'dGVzdC1tb2JpbGUtbWVzc2FnZQ==', 'Message payload matches');
    assert(retrieveMsg.body.message.sender.authId === 'test-user-1', 'Sender auth ID matches');
    console.log('');

    // Test 9: Mobile app retrieves controller status
    console.log('Test 9: Mobile App Retrieves Controller Status');
    const status = await makeRequest('GET', '/mobile/status/1', null, {
      'Authorization': `Bearer ${token}`
    });
    assert(status.status === 200, 'Status retrieval returns 200');
    assert(status.body.success === true, 'Status retrieval is successful');
    assert(status.body.status.protobufPayload === 'dGVzdC1oZWFydGJlYXQ=', 'Status payload matches heartbeat');
    console.log('');

    // Test 10: Rate limiting
    console.log('Test 10: Rate Limiting (sending 26 requests)');
    // Note: We've already made 2 requests in previous tests (test 7 and test 9)
    // So we need to account for those when testing the rate limit of 25
    let successCount = 0;
    let rateLimitedCount = 0;
    
    // Send 23 more requests to reach the limit (2 already sent + 23 = 25)
    for (let i = 0; i < 23; i++) {
      const result = await makeRequest('POST', '/mobile/message', {
        controllerId: 2,
        protobufPayload: `dGVzdC0${i}`
      }, {
        'Authorization': `Bearer ${token}`
      });
      
      if (result.status === 200) successCount++;
      if (result.status === 429) rateLimitedCount++;
    }
    
    // These 3 should be rate limited
    for (let i = 23; i < 26; i++) {
      const result = await makeRequest('POST', '/mobile/message', {
        controllerId: 2,
        protobufPayload: `dGVzdC0${i}`
      }, {
        'Authorization': `Bearer ${token}`
      });
      
      if (result.status === 200) successCount++;
      if (result.status === 429) rateLimitedCount++;
    }
    
    assert(successCount === 23, `Rate limiter allows 23 more requests after 2 previous (got ${successCount})`);
    assert(rateLimitedCount === 3, `Rate limiter blocks requests 26-28 (got ${rateLimitedCount} blocked)`);
    console.log('');

    // Test 11: Messages Are Queued Correctly
    console.log('Test 11: Messages Are Queued Correctly');
    const checkHealth = await makeRequest('GET', '/health');
    // We sent 23 messages in test 10 that succeeded
    assert(checkHealth.body.queues.mobileAppMessages === 23, `All 23 messages are in queue (got ${checkHealth.body.queues.mobileAppMessages})`);
    console.log('');

    // Test 12: FIFO Message Retrieval
    console.log('Test 12: FIFO Message Retrieval');
    const msg1 = await makeRequest('GET', '/controller/messages/2');
    const msg2 = await makeRequest('GET', '/controller/messages/2');
    assert(msg1.body.message.protobufPayload.includes('dGVzdC0'), 'First message retrieved');
    assert(msg2.body.message.protobufPayload.includes('dGVzdC0'), 'Second message retrieved');
    console.log('');

    // Test 13: Validation - Missing Controller ID
    console.log('Test 13: Validation - Missing Controller ID');
    const noControllerId = await makeRequest('POST', '/controller/heartbeat', {
      protobufPayload: 'dGVzdA=='
    });
    assert(noControllerId.status === 400, 'Missing controllerId returns 400');
    assert(noControllerId.body.error.includes('controllerId'), 'Error mentions controllerId');
    console.log('');

    // Test 14: Controller ID = 0 in protobuf (should be rejected from controller)
    console.log('Test 14: Controller ID = 0 in protobuf (should be rejected from controller)');
    // Create a protobuf message with controller_id = 0
    const protobuf = require('protobufjs');
    const path = require('path');
    const protoRoot = await protobuf.load([path.join(process.cwd(), 'bossmarine.proto')]);
    const HvacConfig = protoRoot.lookupType('BM.HvacConfig');
    const hvacWithZero = HvacConfig.create({
      mode: 1,
      tempreature: 72,
      humidity: 50,
      controllerId: 0
    });
    const bufferZero = HvacConfig.encode(hvacWithZero).finish();
    const base64Zero = Buffer.from(bufferZero).toString('base64');
    
    const controllerZeroId = await makeRequest('POST', '/controller/heartbeat', {
      controllerId: 1,
      protobufPayload: base64Zero
    });
    assert(controllerZeroId.status === 400, 'Controller ID = 0 in protobuf returns 400');
    assert(controllerZeroId.body.error.includes('controller_id'), 'Error mentions controller_id');
    console.log('');

    // Test 15: Controller ID = 0 in protobuf (should be rejected from mobile)
    console.log('Test 15: Controller ID = 0 in protobuf (should be rejected from mobile)');
    const mobileZeroId = await makeRequest('POST', '/mobile/message', {
      controllerId: 1,
      protobufPayload: base64Zero
    }, {
      'Authorization': `Bearer ${token}`
    });
    assert(mobileZeroId.status === 400, 'Controller ID = 0 in protobuf returns 400 from mobile');
    assert(mobileZeroId.body.error.includes('controller_id'), 'Error mentions controller_id');
    console.log('');

    // Test 16: Valid Controller ID in protobuf (should be accepted)
    console.log('Test 16: Valid Controller ID in protobuf (should be accepted)');
    const hvacWithValidId = HvacConfig.create({
      mode: 1,
      tempreature: 72,
      humidity: 50,
      controllerId: 12345
    });
    const bufferValidId = HvacConfig.encode(hvacWithValidId).finish();
    const base64ValidId = Buffer.from(bufferValidId).toString('base64');
    
    const controllerValidId = await makeRequest('POST', '/controller/heartbeat', {
      controllerId: 3,
      protobufPayload: base64ValidId
    });
    assert(controllerValidId.status === 200, 'Valid controller ID in protobuf returns 200');
    assert(controllerValidId.body.success === true, 'Heartbeat with valid controller ID is successful');
    console.log('');

    // Test 17: Missing Controller ID in protobuf (should be rejected)
    console.log('Test 17: Missing Controller ID in protobuf (should be rejected)');
    const hvacWithoutId = HvacConfig.create({
      mode: 1,
      tempreature: 72,
      humidity: 50
      // No controllerId field
    });
    const bufferWithoutId = HvacConfig.encode(hvacWithoutId).finish();
    const base64WithoutId = Buffer.from(bufferWithoutId).toString('base64');
    
    const controllerMissingId = await makeRequest('POST', '/controller/heartbeat', {
      controllerId: 4,
      protobufPayload: base64WithoutId
    });
    assert(controllerMissingId.status === 400, 'Missing controller ID in protobuf returns 400');
    assert(controllerMissingId.body.error.includes('required'), 'Error mentions required');
    console.log('');

    // Test 18: 404 for Invalid Route
    console.log('Test 18: 404 for Invalid Route');
    const notFound = await makeRequest('GET', '/invalid-route');
    assert(notFound.status === 404, 'Invalid route returns 404');
    console.log('');

    // Test 19: 200 for Empty Message Queue (No Data)
    console.log('Test 19: 200 for Empty Message Queue (No Data)');
    const emptyMessages = await makeRequest('GET', '/controller/messages/999');
    assert(emptyMessages.status === 200, 'Empty message queue returns 200');
    assert(emptyMessages.body.success === true, 'Response indicates success');
    assert(emptyMessages.body.message === null, 'Message is null when queue is empty');
    console.log('');

    // Test 20: 200 for No Controller Status (No Data)
    console.log('Test 20: 200 for No Controller Status (No Data)');
    const emptyStatus = await makeRequest('GET', '/mobile/status/999', null, {
      'Authorization': `Bearer ${token}`
    });
    assert(emptyStatus.status === 200, 'No controller status returns 200');
    assert(emptyStatus.body.success === true, 'Response indicates success');
    assert(emptyStatus.body.status === null, 'Status is null when no status available');
    console.log('');

    // Test 21: 200 for No Device Association (No Data)
    console.log('Test 21: 200 for No Device Association (No Data)');
    const emptyAssociation = await makeRequest('GET', '/config/device/999', null, {
      'Authorization': `Bearer ${token}`
    });
    assert(emptyAssociation.status === 200, 'No device association returns 200');
    assert(emptyAssociation.body.success === true, 'Response indicates success');
    assert(emptyAssociation.body.association === null, 'Association is null when not found');
    console.log('');

  } catch (error) {
    console.error('Test error:', error);
    failCount++;
  }

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('Test Summary');
  console.log('='.repeat(50));
  console.log(`Total tests: ${testCount}`);
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log('='.repeat(50));

  if (failCount === 0) {
    console.log('\n✓ All tests passed!');
    process.exit(0);
  } else {
    console.log('\n✗ Some tests failed');
    process.exit(1);
  }
}

// Check if server is running before starting tests
console.log('Checking if server is running...');
makeRequest('GET', '/health')
  .then(() => {
    console.log('Server is running. Starting tests...\n');
    runTests();
  })
  .catch(() => {
    console.error('Error: Server is not running. Please start the server first with: npm start');
    process.exit(1);
  });
