import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { BenchStore, StoredArtifact } from './bench-store.js';

/** Contract §3: bundles are application/gzip, at most 200 MB. */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

export class BundleError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number
  ) {
    super(message);
  }
}

// One upload at a time per cell, so the version rotation below is race-free.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run);
  const clear = () => {
    if (locks.get(key) === run) locks.delete(key);
  };
  run.then(clear, clear);
  return run;
}

/**
 * Stream a gzip body to `<dataDir>/<sessionId>/<cellId>.tar.gz` without ever holding it in
 * memory: size is counted and capped, sha256 computed on the fly, gzip magic checked.
 *
 * Re-upload of the same cell (the runner uploads at bench_stop AND at bench_cell_done):
 *  - identical sha256 -> no-op (duplicate: true);
 *  - different bytes  -> the previous file is kept as `<cellId>.v<n>.tar.gz`, the new one
 *    becomes `<cellId>.tar.gz` with version n+1. Evidence is never overwritten.
 */
export async function storeBundle(args: {
  store: BenchStore;
  dataDir: string;
  sessionId: string;
  cellId: string;
  participantId: string | null;
  body: Readable;
  maxBytes?: number;
  expectedSha256?: string;
}): Promise<{ artifact: StoredArtifact; duplicate: boolean }> {
  const { store, dataDir, sessionId, cellId, participantId, body } = args;
  const maxBytes = args.maxBytes ?? MAX_BUNDLE_BYTES;
  const dir = path.join(dataDir, sessionId);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${cellId}.${randomBytes(4).toString('hex')}.part`);

  const hash = createHash('sha256');
  let bytes = 0;
  let first = true;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (first) {
        first = false;
        if (chunk.length < 2 || chunk[0] !== 0x1f || chunk[1] !== 0x8b) {
          return cb(new BundleError('not_gzip', 'Body is not a gzip stream (bad magic bytes)', 400));
        }
      }
      bytes += chunk.length;
      if (bytes > maxBytes) {
        return cb(new BundleError('too_large', `Bundle exceeds ${maxBytes} bytes`, 413));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(body, meter, fs.createWriteStream(tmp, { flags: 'wx' }));
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    if (err instanceof BundleError) throw err;
    throw new BundleError('upload_failed', `Upload interrupted: ${(err as Error).message}`, 400);
  }
  if (bytes === 0) {
    await fs.promises.rm(tmp, { force: true });
    throw new BundleError('empty_body', 'Empty body', 400);
  }
  const sha256 = hash.digest('hex');
  if (args.expectedSha256 && args.expectedSha256.toLowerCase() !== sha256) {
    await fs.promises.rm(tmp, { force: true });
    throw new BundleError('sha256_mismatch', `sha256 of the received bytes is ${sha256}, header said ${args.expectedSha256}`, 422);
  }

  return withLock(cellId, async () => {
    const latest = await store.latestArtifact(cellId);
    if (latest && latest.sha256 === sha256) {
      await fs.promises.rm(tmp, { force: true });
      return { artifact: latest, duplicate: true };
    }
    const finalName = `${cellId}.tar.gz`;
    if (latest) {
      const keptName = `${cellId}.v${latest.version}.tar.gz`;
      await fs.promises.rename(path.join(dir, finalName), path.join(dir, keptName));
      await store.setArtifactPath(cellId, latest.version, `${sessionId}/${keptName}`);
    }
    await fs.promises.rename(tmp, path.join(dir, finalName));
    const artifact: StoredArtifact = {
      cellId,
      sessionId,
      participantId,
      path: `${sessionId}/${finalName}`,
      sha256,
      bytes,
      version: (latest?.version ?? 0) + 1,
      createdAt: new Date(),
    };
    await store.addArtifact(artifact);
    return { artifact, duplicate: false };
  });
}
