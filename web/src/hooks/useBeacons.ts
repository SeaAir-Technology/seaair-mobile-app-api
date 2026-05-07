import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    refetchInterval: 10_000,
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

/**
 * Clear a beacon by setting its expiresAt to now. Backs the "Clear" button
 * on each row of the BeaconsPage. Both createdAt and beaconId are required
 * because the DynamoDB sort key is composite. createdAt is an ISO 8601
 * string and contains characters that need percent-encoding in the URL.
 *
 * On success, invalidates the beacons list and the device list so the
 * Live view's beacon chip clears immediately.
 */
export function useResolveBeacon() {
  const token = useAccessToken();
  const qc = useQueryClient();
  return useMutation<
    { success: true; beaconId: string; createdAt: string },
    Error,
    { createdAt: string; beaconId: string }
  >({
    mutationFn: ({ createdAt, beaconId }) =>
      apiFetch(
        token!,
        `/beacons/${encodeURIComponent(createdAt)}/${encodeURIComponent(beaconId)}/resolve`,
        { method: 'POST' }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['beacons'] });
      qc.invalidateQueries({ queryKey: ['beacons-controller'] });
      qc.invalidateQueries({ queryKey: ['device-list'] });
    },
  });
}
