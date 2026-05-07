import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceStateResponse } from '../lib/types';

export function useDeviceState(controllerId: number | null, refetchMs = 2000) {
  const token = useAccessToken();
  return useQuery<DeviceStateResponse>({
    queryKey: ['device-state', controllerId],
    queryFn: () =>
      apiFetch<DeviceStateResponse>(token!, `/devices/${controllerId}/state`),
    enabled: !!token && controllerId !== null,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
