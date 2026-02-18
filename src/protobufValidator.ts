/**
 * Protobuf validation utilities
 * Validates protobuf messages for security and data integrity
 */

import * as protobuf from 'protobufjs';
import * as path from 'path';

let protobufRoot: protobuf.Root | null = null;

/**
 * Load protobuf definitions from .proto files
 */
async function loadProtobuf(): Promise<protobuf.Root> {
  if (protobufRoot) {
    return protobufRoot;
  }

  // Start from the current working directory (where npm start is run from)
  // or use PROTO_PATH environment variable if set
  const fs = require('fs');
  let protoPath = process.env.PROTO_PATH || process.cwd();
  let maxDepth = 10;
  
  while (maxDepth > 0) {
    if (fs.existsSync(path.join(protoPath, 'package.json')) && 
        fs.existsSync(path.join(protoPath, 'ble.proto'))) {
      break;
    }
    const parent = path.dirname(protoPath);
    if (parent === protoPath) {
      // Reached root
      break;
    }
    protoPath = parent;
    maxDepth--;
  }
  
  try {
    // Create a new Root with the proto directory as the include path
    protobufRoot = new protobuf.Root();
    protobufRoot.resolvePath = function(_origin: string, target: string) {
      // If target is already absolute, return it as-is
      if (path.isAbsolute(target)) {
        return target;
      }
      // Otherwise, resolve relative to protoPath
      return path.join(protoPath, target);
    };
    
    await protobufRoot.load([
      path.join(protoPath, 'ble.proto'),
      path.join(protoPath, 'bossmarine.proto')
    ]);
    
    console.log('[ProtobufValidator] Protobuf definitions loaded successfully from:', protoPath);
    return protobufRoot;
  } catch (error) {
    console.error('[ProtobufValidator] Error loading protobuf definitions:', error);
    throw error;
  }
}

/**
 * Extract controller ID from a protobuf message payload
 * @param base64Payload - Base64 encoded protobuf message
 * @returns Controller ID if found, null if not found or on error
 */
export async function extractControllerIdFromProtobuf(base64Payload: string): Promise<number | null> {
  try {
    const root = await loadProtobuf();
    
    // Decode base64 to buffer
    const buffer = Buffer.from(base64Payload, 'base64');
    
    // Try to decode as BLE.Msg (the main message type)
    try {
      const BleMsg = root.lookupType('BLE.Msg');
      const message = BleMsg.decode(buffer);
      const messageObject = BleMsg.toObject(message, {
        longs: Number,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });

      // Check for controller_id in various message types
      // SyncDevice2Controller contains hvac or utility data
      if (messageObject.syncDevice2Controller) {
        if (messageObject.syncDevice2Controller.hvac?.config?.controllerId !== undefined) {
          return Number(messageObject.syncDevice2Controller.hvac.config.controllerId);
        }
      }

      // SyncController2Device contains hvac or utility data
      if (messageObject.syncController2Device) {
        if (messageObject.syncController2Device.hvac?.controllerId !== undefined) {
          return Number(messageObject.syncController2Device.hvac.controllerId);
        }
      }

      // DeviceInfoResponse contains hvac or utility device data
      if (messageObject.deviceInfoResponse) {
        if (messageObject.deviceInfoResponse.hvac?.config?.controllerId !== undefined) {
          return Number(messageObject.deviceInfoResponse.hvac.config.controllerId);
        }
      }

      // DeviceConfigRequest contains hvac or utility config
      if (messageObject.deviceConfigRequest) {
        if (messageObject.deviceConfigRequest.hvac?.controllerId !== undefined) {
          return Number(messageObject.deviceConfigRequest.hvac.controllerId);
        }
      }

      // No controller_id found in the message
      return null;
    } catch (decodeError) {
      // If it fails to decode as BLE.Msg, try to decode as direct HvacConfig
      try {
        const HvacConfig = root.lookupType('BM.HvacConfig');
        const message = HvacConfig.decode(buffer);
        const messageObject = HvacConfig.toObject(message, {
          longs: Number,
          defaults: true
        });

        if (messageObject.controllerId !== undefined) {
          return Number(messageObject.controllerId);
        }
        return null;
      } catch (hvacError) {
        // Message doesn't contain controller_id or is not a recognized format
        return null;
      }
    }
  } catch (error) {
    console.error('[ProtobufValidator] Error extracting controller ID from protobuf:', error);
    return null;
  }
}

/**
 * Validate that the protobuf message contains a valid controller ID (not 0)
 * @param base64Payload - Base64 encoded protobuf message
 * @returns true if valid (controller_id is not 0 or not present), false if invalid (controller_id is 0)
 */
export async function validateControllerIdInProtobuf(base64Payload: string): Promise<{ valid: boolean; controllerId: number | null }> {
  const controllerId = await extractControllerIdFromProtobuf(base64Payload);
  
  // If controller_id is found and is 0, reject the message
  if (controllerId !== null && controllerId === 0) {
    console.log('[ProtobufValidator] Rejected message: controller_id is 0');
    return { valid: false, controllerId: 0 };
  }
  
  // If controller_id is not found or is non-zero, accept the message
  return { valid: true, controllerId };
}
