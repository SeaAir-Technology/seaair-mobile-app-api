import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceAnalyticsResponse } from '../lib/types';

export function useDeviceAnalytics(
  controllerId: number | null,
  windowExpr: string = '24h',
  refetchMs: number = 5_000
) {
  const token = useAccessToken();
  return useQuery<DeviceAnalyticsResponse>({
    queryKey: ['device-analytics', controllerId, windowExpr],
    queryFn: () =>
      apiFetch<DeviceAnalyticsResponse>(
        token!,
        `/devices/${controllerId}/analytics?window=${windowExpr}`
      ),
    enabled: !!token && controllerId !== null,
    staleTime: refetchMs,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
