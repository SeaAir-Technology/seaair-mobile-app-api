# API Usage Examples

This document provides practical examples of how to use the SeaAir Mobile App API.

## Prerequisites

1. Configure AWS Cognito environment variables:
   ```bash
   export COGNITO_USER_POOL_ID="us-east-1_xxxxxxxxx"
   export COGNITO_CLIENT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxx"
   export AWS_REGION="us-east-1"
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. The server will run on `http://mobile-app-api.seaair.com:3000` (or the port specified by the `PORT` environment variable)

4. Obtain a JWT token from AWS Cognito (see "Getting a Cognito Token" section below)

## Getting a Cognito Token

### Using AWS Amplify (Recommended for Mobile Apps)

```javascript
import { Auth } from 'aws-amplify';

// Sign in
const user = await Auth.signIn('username', 'password');

// Get access token
const session = await Auth.currentSession();
const token = session.getAccessToken().getJwtToken();
```

### Using AWS CLI (For Testing)

```bash
# Authenticate and get token
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id YOUR_CLIENT_ID \
  --auth-parameters USERNAME=user@example.com,PASSWORD=YourPassword \
  --region us-east-1 \
  --query 'AuthenticationResult.AccessToken' \
  --output text
```

### Using cURL (For Testing)

```bash
# Get token (requires Cognito USER_PASSWORD_AUTH flow enabled)
TOKEN=$(curl -X POST \
  -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{
    "AuthFlow": "USER_PASSWORD_AUTH",
    "ClientId": "YOUR_CLIENT_ID",
    "AuthParameters": {
      "USERNAME": "user@example.com",
      "PASSWORD": "YourPassword"
    }
  }' \
  https://cognito-idp.us-east-1.amazonaws.com/ | jq -r '.AuthenticationResult.AccessToken')

echo $TOKEN
```

## Example 1: Controller Sending Heartbeat

A physical controller device sends its status to the API:

```bash
curl -X POST http://mobile-app-api.seaair.com:3000/controller/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "controllerId": 12345,
    "protobufPayload": "CAESBggBEAEYAQ=="
  }'
```

Response:
```json
{
  "success": true,
  "message": "Heartbeat received",
  "controllerId": 12345
}
```

## Example 2: Mobile App Sending Message to Controller

The mobile app must have a valid AWS Cognito JWT token:

```bash
# Use your Cognito token
TOKEN="eyJraWQiOiJ..."  # Your actual Cognito access token

curl -X POST http://mobile-app-api.seaair.com:3000/mobile/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "controllerId": 12345,
    "protobufPayload": "CAESBggBEAEYAiICCAE="
  }'
```

Response:
```json
{
  "success": true,
  "message": "Message queued for controller",
  "controllerId": 12345
}
```

## Example 3: Controller Retrieving Messages

The controller polls the API to check for messages from the mobile app:

```bash
curl -X GET http://mobile-app-api.seaair.com:3000/controller/messages/12345
```

Response when messages are available:
```json
{
  "success": true,
  "message": {
    "timestamp": "2025-12-18T00:00:00.000Z",
    "sender": {
      "ip": "192.168.1.100",
      "type": "mobile",
      "authId": "user-xyz789"
    },
    "controllerId": 12345,
    "protobufPayload": "CAESBggBEAEYAiICCAE=",
    "expiresAt": 1766017200000
  }
}
```

Response when no messages:
```json
{
  "success": false,
  "message": "No messages available"
}
```

## Example 4: Mobile App Retrieving Controller Status

The mobile app checks the latest status from a controller:

```bash
curl -X GET http://mobile-app-api.seaair.com:3000/mobile/status/12345 \
  -H "Authorization: Bearer $TOKEN"
```

Response:
```json
{
  "success": true,
  "status": {
    "timestamp": "2025-12-18T00:00:00.000Z",
    "sender": {
      "ip": "192.168.1.50",
      "type": "controller"
    },
    "controllerId": 12345,
    "protobufPayload": "CAESBggBEAEYAQ==",
    "expiresAt": 1766017200000
  }
}
```

## Example 5: Health Check

Check the API health and queue statistics:

```bash
curl http://mobile-app-api.seaair.com:3000/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "timestamp": "2025-12-18T00:00:00.000Z",
  "queues": {
    "mobileAppControllers": 5,
    "mobileAppMessages": 12,
    "controllerMessages": 5
  },
  "rateLimiter": {
    "trackedKeys": 10
  }
}
```

## Example 6: Rate Limiting

The API will block excessive requests (more than 60 in 30 seconds):

```bash
# Send 26 requests rapidly
for i in {1..26}; do
  curl -X POST http://mobile-app-api.seaair.com:3000/mobile/message \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"controllerId\": 12345, \"protobufPayload\": \"test-$i\"}"
done
```

The first 25 requests will succeed. The 26th request will return:
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Maximum 60 requests per 30 seconds."
}
```

## Error Handling

### Missing Authentication

```bash
curl -X POST http://mobile-app-api.seaair.com:3000/mobile/message \
  -H "Content-Type: application/json" \
  -d '{
    "controllerId": 12345,
    "protobufPayload": "test"
  }'
```

Response (401):
```json
{
  "error": "No authorization header provided",
  "message": "Authorization header with Bearer token is required"
}
```

### Invalid Token

```bash
curl -X POST http://mobile-app-api.seaair.com:3000/mobile/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid-token" \
  -d '{
    "controllerId": 12345,
    "protobufPayload": "test"
  }'
```

Response (401):
```json
{
  "error": "Invalid token",
  "message": "JWT token is invalid"
}
```

### Missing Required Fields

```bash
curl -X POST http://mobile-app-api.seaair.com:3000/controller/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "protobufPayload": "test"
  }'
```

Response (400):
```json
{
  "error": "controllerId is required"
}
```

## Protobuf Payload Format

The `protobufPayload` field should contain base64-encoded Protocol Buffer messages according to the definitions in `ble.proto` and `bossmarine.proto`.

Example encoding in Node.js:
```javascript
const protobuf = require('protobufjs');

// Load proto files
const root = await protobuf.load(['ble.proto', 'bossmarine.proto']);

// Create a message
const HvacConfig = root.lookupType('BM.HvacConfig');
const message = HvacConfig.create({
  mode: 1, // COOL
  temperature: 72,
  humidity: 50
});

// Encode to buffer
const buffer = HvacConfig.encode(message).finish();

// Convert to base64 for API
const base64Payload = buffer.toString('base64');
```

## Integration Flow

### Controller → API → Mobile App

1. Controller sends heartbeat with status:
   ```
   POST /controller/heartbeat
   ```

2. Mobile app polls for status:
   ```
   GET /mobile/status/:controllerId
   ```

### Mobile App → API → Controller

1. Mobile app sends command:
   ```
   POST /mobile/message
   ```

2. Controller polls for messages:
   ```
   GET /controller/messages/:controllerId
   ```

## Running Tests

Run the included test suite:

```bash
# Start the server in one terminal
npm start

# Run tests in another terminal
npm test
```

Or run the manual rate limiting test:
```bash
cd /home/runner/work/seaair-mobile-app-api/seaair-mobile-app-api
bash /tmp/test-rate-limiting.sh
```
