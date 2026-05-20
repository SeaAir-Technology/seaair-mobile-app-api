import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceQueueResponse } from '../lib/types';

/**
 * Polls /devices/:id/queue so the controller detail page can render a live
 * unread-counter badge. 2-second cadence matches useDeviceState; the count
 * visibly ticks down as the firmware XREADGROUP-drains its queue.
 */
export function useDeviceQueue(controllerId: number | null, refetchMs = 2000) {
  const token = useAccessToken();
  return useQuery<DeviceQueueResponse>({
    queryKey: ['device-queue', controllerId],
    queryFn: () =>
      apiFetch<DeviceQueueResponse>(token!, `/devices/${controllerId}/queue`),
    enabled: !!token && controllerId !== null,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
