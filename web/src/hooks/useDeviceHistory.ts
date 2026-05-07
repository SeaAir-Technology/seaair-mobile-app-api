import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import { filtersToQuery } from '../components/SearchBar';
import type { DeviceHistoryResponse, PayloadFilter } from '../lib/types';

interface Args {
  controllerId: number | null;
  count?: number;
  direction?: 'both' | 'fw2mobile' | 'mobile2fw';
  filters?: PayloadFilter[];
  refetchMs?: number;
}

export function useDeviceHistory({
  controllerId,
  count = 200,
  direction = 'both',
  filters = [],
  refetchMs = 5000,
}: Args) {
  const token = useAccessToken();
  return useQuery<DeviceHistoryResponse>({
    queryKey: ['device-history', controllerId, count, direction, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('count', String(count));
      params.set('direction', direction);
      for (const q of filtersToQuery(filters)) params.append('filter', q);
      return apiFetch<DeviceHistoryResponse>(
        token!,
        `/devices/${controllerId}/history?${params}`
      );
    },
    enabled: !!token && controllerId !== null,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
