import { useQuery } from '@tanstack/react-query';

export interface HealthResponse {
  ok: boolean;
  name: string;
  time: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export function useServerHealth() {
  return useQuery({
    queryKey: ['server-health'],
    queryFn: () => fetchJson<HealthResponse>('/api/health'),
    refetchInterval: 15_000,
    retry: false,
  });
}
