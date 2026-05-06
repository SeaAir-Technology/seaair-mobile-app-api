import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { FirehoseResponse } from '../lib/types';

// Polls the cross-controller firehose. 2s feels live without hammering the
// API; the underlying stream is MAXLEN ~200 so each poll is O(1).
export function useFirehose(limit = 100, refetchMs = 2000) {
  const token = useAccessToken();
  return useQuery<FirehoseResponse>({
    queryKey: ['firehose', limit],
    queryFn: () =>
      apiFetch<FirehoseResponse>(token!, `/messages/recent?limit=${limit}`),
    enabled: !!token,
    refetchInterval: refetchMs,
    refetchIntervalInBackground: false,
  });
}
