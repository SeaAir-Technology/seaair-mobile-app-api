import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceListResponse } from '../lib/types';

// Polls the rolled-up device list for the active window. The default 1m
// window matches the firmware heartbeat cadence: every poll round-trip is
// bounded to currently-online devices, so 3-second refetches stay cheap on
// both ends. The window argument is passed straight through to the backend
// (parseWindow accepts e.g. "30s", "1m", "24h").
export function useDeviceList(window: string = '1m', refetchMs = 3000) {
  const token = useAccessToken();
  return useQuery<DeviceListResponse>({
    queryKey: ['device-list', window],
    queryFn: () =>
      apiFetch<DeviceListResponse>(token!, `/devices?window=${window}`),
    enabled: !!token,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
