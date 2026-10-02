import os from 'node:os';
import { isLoopbackHost, normalizeHost } from '../core/bench-backends.js';

/**
 * Where a request really came from, for the bench backends feature (V0.2).
 *
 * The Fastify app runs with `trustProxy: true`, so `request.ip` follows
 * X-Forwarded-For. That is right behind a local proxy (the telão's Vite dev
 * server) but would let any LAN client choose the address the arena probes
 * ("probe this other machine for me") or pose as loopback. So the forwarded
 * address is honoured ONLY when the TCP peer itself is loopback; otherwise the
 * peer address is used. Stricter than `trustProxy: true`, never looser.
 */
export interface ClientRequestLike {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

const header = (req: ClientRequestLike, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const DEV_HOST_RE = /^[A-Za-z0-9.:-]{1,64}$/;

export function peerAddress(req: ClientRequestLike): string {
  return normalizeHost(req.socket?.remoteAddress || req.ip);
}

/**
 * The host a registering participant is reachable at. Never taken from the body.
 * `x-bench-dev-host` overrides it only when `BENCH_DEV=1` (the simulator runs all
 * fake Ollamas on 127.0.0.x, whose requests all arrive from 127.0.0.1).
 */
export function resolveClientHost(req: ClientRequestLike, env: NodeJS.ProcessEnv = process.env): string {
  if (env.BENCH_DEV === '1') {
    const dev = header(req, 'x-bench-dev-host');
    if (dev && DEV_HOST_RE.test(dev)) return normalizeHost(dev);
  }
  const peer = peerAddress(req);
  return isLoopbackHost(peer) ? normalizeHost(req.ip) : peer;
}

/**
 * True for the owner / orchestrator on the arena machine: the TCP peer and the
 * forwarded address are both loopback, and the request did not come through the
 * telão's dev proxy (which marks `/api/*` with `x-bench-via-telao`, because that
 * port is open to the whole LAN). Only these callers see raw hosts (`provider_url`).
 */
export function isLoopbackRequest(req: ClientRequestLike): boolean {
  if (header(req, 'x-bench-via-telao')) return false;
  return isLoopbackHost(peerAddress(req)) && isLoopbackHost(req.ip);
}

/** Candidate `http://<ip>:<port>/bench-join` URLs for the arena machine, private LAN ranges first. */
export function lanJoinUrls(port: number, interfaces = os.networkInterfaces()): string[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const ips: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  return ips.sort((x, y) => rank(x) - rank(y)).map((ip) => `http://${ip}:${port}/bench-join`);
}
