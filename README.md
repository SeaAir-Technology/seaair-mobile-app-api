# SeaAir Mobile App API

Transport layer API for SeaAir mobile app and physical controller communication using Protocol Buffers.

> **Note**: This project has been migrated to TypeScript. See [TYPESCRIPT-MIGRATION.md](TYPESCRIPT-MIGRATION.md) for details.

## Overview

This Node.js API serves as a message transport layer between a mobile application and physical hardware controllers. The controllers communicate via WiFi while the mobile app can communicate either directly via Bluetooth or through this API when Bluetooth is unavailable.

## Features

- **In-memory message queues** with hashmap structure for fast access
- **Separate queues** for mobile app and controller messages
- **Message expiration** (11 minutes)
- **JWT authentication** for mobile app routes
- **Rate limiting** (60 requests per 30 seconds per controller/account)
- **Protobuf payload** support
- **Request logging** to console

## Installation

```bash
npm install
```

## Building the Project

Since the project is now written in TypeScript, you need to build it first:

```bash
npm run build
```

This compiles the TypeScript code to JavaScript in the `dist/` directory.

## Running the Server

```bash
npm start
```

The server runs on port 3000 by default. Use the `PORT` environment variable to change it:

```bash
PORT=8080 npm start
```

## API Endpoints

### Controller Routes (No Authentication Required)

#### POST /controller/heartbeat
Controller sends status updates (heartbeat).

**Request Body:**
```json
{
  "controllerId": "number (required, non-negative integer)",
  "protobufPayload": "string (base64 encoded protobuf)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Heartbeat received",
  "controllerId": 12345
}
```

#### GET /controller/messages/:controllerId
Controller retrieves queued messages from mobile app. The `:controllerId` parameter should be a numeric value.

**Response (when messages available):**
```json
{
  "success": true,
  "message": {
    "timestamp": "ISO 8601 timestamp",
    "sender": {
      "ip": "IP address",
      "type": "mobile",
      "authId": "Cognito auth ID"
    },
    "controllerId": 12345,
    "protobufPayload": "base64 encoded protobuf"
  }
}
```

**Response (no messages):**
```json
{
  "success": false,
  "message": "No messages available"
}
```

### Mobile App Routes (JWT Authentication Required)

#### POST /mobile/message
Mobile app sends message to controller.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Request Body:**
```json
{
  "controllerId": "number (required, non-negative integer)",
  "protobufPayload": "string (base64 encoded protobuf)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message queued for controller",
  "controllerId": 12345
}
```

#### GET /mobile/status/:controllerId
Mobile app retrieves latest controller status. The `:controllerId` parameter should be a numeric value.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (when status available):**
```json
{
  "success": true,
  "status": {
    "timestamp": "ISO 8601 timestamp",
    "sender": {
      "ip": "IP address",
      "type": "controller"
    },
    "controllerId": 12345,
    "protobufPayload": "base64 encoded protobuf"
  }
}
```

### Configuration Routes (JWT Authentication Required)

#### POST /config/device
Associate a controller device with a user account. This creates a durable association in DynamoDB.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Request Body:**
```json
{
  "controllerId": "number (required, non-negative integer)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Device associated successfully",
  "userId": "cognito-user-sub",
  "controllerId": 12345
}
```

#### GET /config/device/:controllerId
Retrieve user-device association from DynamoDB. The `:controllerId` parameter should be a numeric value.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (when association exists):**
```json
{
  "success": true,
  "association": {
    "userId": "cognito-user-sub",
    "controllerId": 12345,
    "createdAt": "ISO 8601 timestamp",
    "updatedAt": "ISO 8601 timestamp"
  }
}
```

**Response (no association):**
```json
{
  "success": false,
  "message": "No device association found"
}
```

#### DELETE /config/device/:controllerId
Delete user-device association from DynamoDB. The `:controllerId` parameter should be a numeric value.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "message": "Device dissociated successfully",
  "userId": "cognito-user-sub",
  "controllerId": 12345
}
```

### Utility Endpoints

#### GET /health
Health check endpoint with queue statistics and Cognito configuration status.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 12345.67,
  "timestamp": "ISO 8601 timestamp",
  "queues": {
    "mobileAppControllers": 5,
    "mobileAppMessages": 12,
    "controllerMessages": 5
  },
  "rateLimiter": {
    "trackedKeys": 10
  },
  "cognito": {
    "configured": true,
    "userPoolId": "us-east-1_xxxxxxxxx",
    "region": "us-east-1"
  }
}
```

## Message Queue Architecture

### Mobile App Queue
- Hashmap structure: `controllerId -> array of messages`
- Messages are processed in FIFO order
- Multiple messages can be queued per controller
- Messages expire after 11 minutes
- Messages are deleted after retrieval

### Controller Queue
- Hashmap structure: `controllerId -> single message`
- Only stores the latest heartbeat message
- Messages expire after 11 minutes
- Messages are NOT deleted after retrieval (allows multiple devices to read the latest status)

## Rate Limiting

The API implements rate limiting to prevent abuse:
- Maximum **60 requests per 30 seconds** per controller from the same account
- Maximum **60 requests per 30 seconds** per controller from the same IP address
- Requests exceeding the limit receive a `429 Too Many Requests` response

## JWT Authentication

Mobile app routes require AWS Cognito JWT authentication via the `Authorization` header:

```
Authorization: Bearer <COGNITO_JWT_TOKEN>
```

### AWS Cognito Setup

The AWS Cognito configuration is now centralized in `src/config/cognito.ts`. You have two options for configuration:

### Option 1: Configure in Code (Recommended)

Edit `src/config/cognito.ts` and set your values directly:

```typescript
export const cognitoConfig: CognitoConfig = {
  userPoolId: 'us-east-1_YourPoolId',
  clientId: 'YourClientId12345',
  region: 'us-east-1',
};
```

### Option 2: Use Environment Variables

1. Create an AWS Cognito User Pool in your AWS account
2. Create an App Client for your mobile application
3. Set the environment variables:
   - `COGNITO_USER_POOL_ID`: Your Cognito User Pool ID (e.g., us-east-1_xxxxxxxxx)
   - `COGNITO_CLIENT_ID`: Your Cognito App Client ID
   - `AWS_REGION`: AWS region where your User Pool is located (default: us-east-1)
   - `AWS_ACCESS_KEY_ID`: AWS Access Key ID for DynamoDB access (optional - use IAM roles in production)
   - `AWS_SECRET_ACCESS_KEY`: AWS Secret Access Key for DynamoDB access (optional - use IAM roles in production)

See [CONFIGURATION.md](CONFIGURATION.md) for detailed setup instructions.

### Token Requirements

The mobile app must:
- Obtain JWT access tokens from AWS Cognito (using AWS Amplify or Cognito SDK)
- Include the token in the `Authorization: Bearer <token>` header
- Handle token expiration (Cognito tokens typically expire after 1 hour)
- Refresh tokens when they expire using Cognito's refresh token mechanism

The JWT token will contain:
- `sub`: Unique user identifier from Cognito
- `username` or `cognito:username`: User's username
- `email`: User's email (if available)
- Other Cognito claims

## Environment Variables

- `PORT`: Server port (default: 3000)
- `COGNITO_USER_POOL_ID`: AWS Cognito User Pool ID (required for authentication)
- `COGNITO_CLIENT_ID`: AWS Cognito App Client ID (required for authentication)
- `AWS_REGION`: AWS region for Cognito and DynamoDB (default: us-east-1)
- `AWS_ACCESS_KEY_ID`: AWS Access Key ID for DynamoDB access (optional - recommended to use IAM roles in production)
- `AWS_SECRET_ACCESS_KEY`: AWS Secret Access Key for DynamoDB access (optional - recommended to use IAM roles in production)

## DynamoDB Configuration

The API uses AWS DynamoDB to store durable user-device associations. The table structure is:

- **Table Name**: `seaair-user-device`
- **Partition Key**: `user-id` (String) - Cognito user sub/ID
- **Sort Key**: `controller-id` (String) - Controller device ID (stored as string representation of numeric ID)
- **Attributes**:
  - `createdAt`: ISO 8601 timestamp when association was created
  - `updatedAt`: ISO 8601 timestamp when association was last updated

### DynamoDB Setup

1. Create a DynamoDB table in your AWS account with the following configuration:
   - Table name: `seaair-user-device`
   - Partition key: `user-id` (String)
   - Sort key: `controller-id` (String)

2. Configure AWS credentials:
   - **For local development**: Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in your `.env` file
   - **For production**: Use IAM roles attached to your EC2/ECS/Lambda instances (recommended)

The API will automatically use the configured credentials to access DynamoDB.

**Note**: Controller IDs are numeric (uint64_t) in the API but stored as strings in DynamoDB for compatibility.

## Message Format

All messages include:
- `timestamp`: ISO 8601 timestamp
- `sender`: Object with `ip`, `type`, and optionally `authId`
- `controllerId`: Unique controller identifier (numeric, non-negative integer)
- `protobufPayload`: Base64 encoded protobuf message

## Protobuf Definitions

The API uses Protocol Buffer definitions in:
- `ble.proto`: BLE communication messages
- `bossmarine.proto`: Boss Marine device definitions (HvacConfig, etc.)

## Logging

All API requests and payloads are logged to the console for debugging and monitoring purposes.

## Development Notes

- The message queue is in-memory and will be lost on server restart
- JWT secret should be set via environment variable in production
- The `/test/generate-token` endpoint should be disabled in production
