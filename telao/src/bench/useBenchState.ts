import { useCallback, useEffect, useRef, useState } from 'react';
import { useTelaoSocket } from '../hooks/useTelaoSocket';
import type { BenchState } from './types';

const POLL_CONNECTED_MS = 15000; // slow consistency check while the WebSocket is up
const POLL_DISCONNECTED_MS = 3000; // fallback while it is down

/**
 * Live bench state for the telão views. The server pushes `bench_state` over the
 * WebSocket (hydrated on register); GET /bench/state is only the fallback, so a
 * telão opened mid-run, or after a server restart, recovers on its own.
 */
export function useBenchState(view: 'bench' | 'bench-control') {
  const [state, setState] = useState<BenchState | null>(null);
  const [lastUpdate, setLastUpdate] = useState(0);
  const connectedRef = useRef(false);

  const apply = useCallback((s: BenchState) => {
    setState(s);
    setLastUpdate(Date.now());
  }, []);

  const connected = useTelaoSocket(view, (msg) => {
    if (msg?.type === 'bench_state') apply(msg as BenchState);
  });
  connectedRef.current = connected;

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/bench/state');
      if (r.ok) apply(await r.json());
    } catch {
      /* server restarting: the next poll or the WS reconnect recovers */
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(
        async () => {
          await refresh();
          loop();
        },
        connectedRef.current ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS
      );
    };
    loop();
    return () => clearTimeout(timer);
  }, [refresh]);

  return { state, connected, lastUpdate, refresh };
}
