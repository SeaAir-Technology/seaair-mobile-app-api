import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { UsersResponse } from '../lib/types';

export function useAdminUsers() {
  const token = useAccessToken();
  return useQuery<UsersResponse>({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<UsersResponse>(token!, '/admin/users'),
    enabled: !!token,
  });
}

export function useGrantUser() {
  const token = useAccessToken();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      apiFetch(
        token!,
        `/admin/users/${encodeURIComponent(username)}/grant`,
        { method: 'POST' }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useRevokeUser() {
  const token = useAccessToken();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      apiFetch(
        token!,
        `/admin/users/${encodeURIComponent(username)}/revoke`,
        { method: 'POST' }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}
