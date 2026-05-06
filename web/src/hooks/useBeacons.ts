import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type {
  BeaconsResponse,
  BeaconsForControllerResponse,
} from '../lib/types';

export function useBeacons(pageSize = 50) {
  const token = useAccessToken();
  return useInfiniteQuery<BeaconsResponse>({
    queryKey: ['beacons', pageSize],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      if (pageParam) params.set('before', pageParam as string);
      return apiFetch<BeaconsResponse>(token!, `/beacons?${params}`);
    },
    enabled: !!token,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useBeaconsForController(controllerId: number | null) {
  const token = useAccessToken();
  return useQuery<BeaconsForControllerResponse>({
    queryKey: ['beacons-controller', controllerId],
    queryFn: () =>
      apiFetch<BeaconsForControllerResponse>(
        token!,
        `/beacons/controller/${controllerId}?limit=50`
      ),
    enabled: !!token && controllerId !== null,
  });
}
