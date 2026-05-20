import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { MarkAllReceivedResponse } from '../lib/types';

/**
 * Backs the "Mark all received" button on the controller detail page.
 * POSTs to /devices/:id/mark-all-received which advances the firmware
 * consumer group's cursor past anything currently queued and acknowledges
 * any pending entries. After it succeeds, every device-scoped query is
 * invalidated so the UI reflects the cleared queue immediately.
 */
export function useMarkAllReceived() {
  const token = useAccessToken();
  const qc = useQueryClient();
  return useMutation<MarkAllReceivedResponse, Error, number>({
    mutationFn: (controllerId) =>
      apiFetch<MarkAllReceivedResponse>(
        token!,
        `/devices/${controllerId}/mark-all-received`,
        { method: 'POST' }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-list'] });
      qc.invalidateQueries({ queryKey: ['device-state'] });
      qc.invalidateQueries({ queryKey: ['device-queue'] });
      qc.invalidateQueries({ queryKey: ['device-history'] });
      qc.invalidateQueries({ queryKey: ['firehose'] });
    },
  });
}
