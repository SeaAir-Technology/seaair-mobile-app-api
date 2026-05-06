import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceListResponse } from '../lib/types';

// Polls the rolled-up device list for the past N hours. The endpoint scans
// per-controller streams and joins recent beacons, so 5-second polling is
// the right cadence: aggregate state, not live message flow.
export function useDeviceList(windowHours = 24, refetchMs = 5000) {
  const token = useAccessToken();
  return useQuery<DeviceListResponse>({
    queryKey: ['device-list', windowHours],
    queryFn: () =>
      apiFetch<DeviceListResponse>(token!, `/devices?window=${windowHours}h`),
    enabled: !!token,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
