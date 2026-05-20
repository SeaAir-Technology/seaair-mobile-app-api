// Mirrors the shapes returned by /dashboard/api/*. Keep in sync with
// src/routes/dashboard.ts and src/services/* in the API repo.

export interface MessageSender {
  ip: string;
  type: 'mobile' | 'controller';
  authId?: string;
}

export interface Message {
  timestamp: string;
  sender: MessageSender;
  controllerId: number;
  protobufPayload: string;
  expiresAt?: number;
  streamId?: string;
  streamKey?: string;
}

export interface DecodedPayload {
  typeName: string;
  data: Record<string, unknown>;
}

export interface EnrichedMessage extends Message {
  decoded: DecodedPayload | null;
  direction?: 'fw2mobile' | 'mobile2fw';
}

export interface FirehoseEntry {
  firehoseId: string;
  controllerId: number;
  direction: 'fw2mobile' | 'mobile2fw';
  streamId: string;
  timestamp: string;
  senderType: 'mobile' | 'controller';
  authId?: string;
}

export interface MeResponse {
  sub: string;
  username: string;
  email?: string;
  groups: string[];
  isDashboardAdmin: boolean;
}

export interface FirehoseResponse {
  count: number;
  entries: FirehoseEntry[];
}

export interface DeviceSummary {
  controllerId: number;
  lastSeenAt: string;
  ageMs: number;
  alive: boolean;
  beacon: boolean;
}

export interface DeviceListResponse {
  windowMs: number;
  count: number;
  devices: DeviceSummary[];
}

export interface DeviceStateResponse {
  controllerId: number;
  alive: boolean;
  ageMs?: number;
  latest: EnrichedMessage | null;
}

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'exists';

export interface PayloadFilter {
  path: string;
  op: FilterOp;
  value?: string | number | boolean;
}

export interface DeviceHistoryResponse {
  controllerId: number;
  direction: 'fw2mobile' | 'mobile2fw' | 'both';
  filters: PayloadFilter[];
  count: number;
  totalScanned: number;
  messages: EnrichedMessage[];
}

export interface AnalyticsSeries {
  [path: string]: Array<{ t: number; v: number }>;
}

export interface DeviceAnalyticsResponse {
  controllerId: number;
  windowMs: number;
  scanned: number;
  series: AnalyticsSeries;
  seriesNames: string[];
}

export interface DeviceQueueResponse {
  controllerId: number;
  direction: 'fw2mobile' | 'mobile2fw';
  unread: number;
  pending: number;
  streamLength: number;
  capped?: boolean;
}

export interface MarkAllReceivedResponse {
  controllerId: number;
  direction: 'fw2mobile' | 'mobile2fw';
  pelAcked: number;
  skipped: number;
  cursorAdvancedTo: string;
  streamLength: number;
}

export interface Beacon {
  beaconId: string;
  controllerId: number;
  userId: string;
  userEmail: string;
  message?: string;
  createdAt: string;
  expiresAt: number;
}

export interface BeaconsResponse {
  count: number;
  beacons: Beacon[];
  nextCursor?: string;
}

export interface BeaconsForControllerResponse {
  controllerId: number;
  count: number;
  beacons: Beacon[];
}

export interface DashboardUser {
  sub: string;
  username: string;
  email?: string;
  enabled: boolean;
  status?: string;
  isDashboardAdmin: boolean;
  createdAt?: string;
}

export interface UsersResponse {
  count: number;
  users: DashboardUser[];
}
