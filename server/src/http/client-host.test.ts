import { describe, it, expect } from 'vitest';
import { isLoopbackRequest, lanJoinUrls, peerAddress, resolveClientHost, type ClientRequestLike } from './client-host.js';

const req = (peer: string, ip = peer, headers: Record<string, string> = {}): ClientRequestLike => ({ ip, headers, socket: { remoteAddress: peer } });

describe('resolveClientHost', () => {
  it('uses the TCP peer for a LAN client and normalises IPv4-mapped IPv6', () => {
    expect(resolveClientHost(req('::ffff:192.168.1.20'))).toBe('192.168.1.20');
    expect(resolveClientHost(req('192.168.1.20'))).toBe('192.168.1.20');
  });

  it('ignores a spoofed X-Forwarded-For from a non-loopback peer (request.ip would follow it under trustProxy)', () => {
    expect(resolveClientHost(req('192.168.1.20', '10.9.9.9', { 'x-forwarded-for': '10.9.9.9' }))).toBe('192.168.1.20');
  });

  it('honours the forwarded address when the peer is a local proxy', () => {
    expect(resolveClientHost(req('127.0.0.1', '192.168.1.30'))).toBe('192.168.1.30');
  });

  it('x-bench-dev-host works only with BENCH_DEV=1 and a sane value', () => {
    const r = req('127.0.0.1', '127.0.0.1', { 'x-bench-dev-host': '127.0.0.7' });
    expect(resolveClientHost(r, {})).toBe('127.0.0.1');
    expect(resolveClientHost(r, { BENCH_DEV: '0' })).toBe('127.0.0.1');
    expect(resolveClientHost(r, { BENCH_DEV: '1' })).toBe('127.0.0.7');
    const bad = req('127.0.0.1', '127.0.0.1', { 'x-bench-dev-host': 'evil.example.com/../x' });
    expect(resolveClientHost(bad, { BENCH_DEV: '1' })).toBe('127.0.0.1');
  });

  it('falls back to request.ip when there is no socket', () => {
    expect(peerAddress({ ip: '::ffff:10.0.0.4', headers: {} })).toBe('10.0.0.4');
  });
});

describe('isLoopbackRequest (gates provider_url)', () => {
  it('is true for the owner / orchestrator on the arena machine', () => {
    expect(isLoopbackRequest(req('127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('::1'))).toBe(true);
    expect(isLoopbackRequest(req('::ffff:127.0.0.1'))).toBe(true);
  });

  it('is false for a LAN client', () => {
    expect(isLoopbackRequest(req('192.168.1.20'))).toBe(false);
  });

  it('is false when a LAN client forges X-Forwarded-For: 127.0.0.1', () => {
    expect(isLoopbackRequest(req('192.168.1.20', '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('is false for a loopback proxy forwarding a LAN client', () => {
    expect(isLoopbackRequest(req('127.0.0.1', '192.168.1.30'))).toBe(false);
  });

  it('is false for requests marked by the telão dev proxy (its port is open to the LAN)', () => {
    expect(isLoopbackRequest(req('127.0.0.1', '127.0.0.1', { 'x-bench-via-telao': '1' }))).toBe(false);
  });
});

describe('lanJoinUrls', () => {
  it('lists external IPv4 only, private 192.168 first', () => {
    const urls = lanJoinUrls(3000, {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.1.10', family: 'IPv4', internal: false },
      ],
    } as any);
    expect(urls).toEqual(['http://192.168.1.10:3000/bench-join', 'http://172.17.0.1:3000/bench-join']);
  });
});
