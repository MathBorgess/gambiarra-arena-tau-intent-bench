import { useCallback, useEffect, useState } from 'react';
import type { BackendsResponse } from './types';

const POLL_MS = 4000;

/** Backends registered from /bench-join (V0.2). Polled: they change rarely and are not part of bench_state. */
export function useBackends() {
  const [data, setData] = useState<BackendsResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/bench/backends');
      if (r.ok) setData(await r.json());
    } catch {
      /* server restarting: the next poll recovers */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, refresh };
}
