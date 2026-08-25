import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { DeviceAnalyticsResponse } from '../lib/types';

/** Series whose leaf name carries millivolts on the wire. Displayed in volts
 *  (hundredths) everywhere on the dashboard: chart lines, Y axis, and the
 *  state tooltip all read the converted series. */
function millivoltSeriesToVolts(resp: DeviceAnalyticsResponse): DeviceAnalyticsResponse {
  const series: DeviceAnalyticsResponse['series'] = {};
  for (const [name, points] of Object.entries(resp.series)) {
    const leaf = name.split('.').pop();
    series[name] =
      leaf === 'voltage'
        ? points.map((p) =>
            typeof p.v === 'number' ? { ...p, v: Math.round(p.v / 10) / 100 } : p
          )
        : points;
  }
  return { ...resp, series };
}

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
    select: millivoltSeriesToVolts,
    enabled: !!token && controllerId !== null,
    staleTime: refetchMs,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
