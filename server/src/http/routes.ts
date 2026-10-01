import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { RoundManager } from '../core/rounds.js';
import { VoteManager } from '../core/votes.js';
import { MetricsManager } from '../core/metrics.js';
import { EventLogger } from '../core/eventlog.js';
import type { WorldEngine } from '../core/world.js';
import type { WebSocketHub } from '../ws/hub.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { BenchError, CELL_ID_RE, type BenchEngine } from '../core/bench.js';
import type { BenchStore } from '../core/bench-store.js';
import { BundleError, MAX_BUNDLE_BYTES, storeBundle } from '../core/bench-artifacts.js';
import { BenchArmSchema, BenchModeSchema } from '../ws/schemas.js';
import { BackendError, backendExportRow, backendView, type BackendRegistry, type RunnerView, type StoredBackend } from '../core/bench-backends.js';
import { isLoopbackRequest, lanJoinUrls, resolveClientHost } from './client-host.js';

const CreateSessionSchema = z.object({
  pinLength: z.number().optional().default(6),
});

const CreateRoundSchema = z.object({
  prompt: z.string(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  deadlineMs: z.number().optional(),
  seed: z.number().optional(),
  svgMode: z.boolean().optional(),
});

const StartRoundSchema = z.object({
  roundId: z.string(),
});

const StopRoundSchema = z.object({
  roundId: z.string(),
});

const CastVoteSchema = z.object({
  roundId: z.string(),
  participantId: z.string(),
  score: z.number().min(0).max(5),
  voterId: z.string().optional(), // Optional: use localStorage ID from client
  responseTime: z.number().optional(), // ms from viewing response to voting
  userAgent: z.string().optional(), // browser/device info
});

const RoundIdSchema = z.object({
  roundId: z.string(),
});

const GetVotedSchema = z.object({
  roundId: z.string(),
  voterId: z.string(),
});

const KickParticipantSchema = z.object({
  participantId: z.string(),
});

// ---- Bench mode request bodies (contract §3) ----
const uniqueArms = (arms: string[]) => new Set(arms).size === arms.length;
const BenchAssignBodySchema = z.object({
  participant_id: z.string().min(1),
  // null = back to the default (all arms, order shuffled by the cell seed)
  arms: z.array(BenchArmSchema).min(1).max(3).refine(uniqueArms, 'arms must not repeat').nullable().optional(),
  mode: BenchModeSchema.optional(),
  seed: z.number().int().min(1).max(2 ** 31 - 1).optional(),
  k_max: z.number().int().min(1).max(50).optional(),
  deadline_s: z.number().int().min(1).max(86400).optional(),
  max_productive_turns: z.number().int().min(1).max(200).optional(),
});

const BenchStartBodySchema = z.object({
  mode: BenchModeSchema.optional(),
  only_qualified: z.boolean().optional(),
  participant_ids: z.array(z.string().min(1)).optional(),
});

const BenchStopBodySchema = z.object({
  participant_id: z.string().min(1).optional(),
});

// ---- Bench V0.2 backends (docs/BENCH-V0.2-REMOTE-BACKENDS.md §2) ----
const noControl = /^[^\u0000-\u001f\u007f]*$/;
const optStr = (max: number) => z.string().trim().max(max).regex(noControl).nullish();
const BackendRegisterBodySchema = z.object({
  nickname: z.string().trim().min(1).max(40).regex(noControl),
  model: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._\-:/@+]*$/, 'invalid model name'),
  port: z.number().int().min(1).max(65535).default(11434),
  declared_hardware: z
    .object({
      chip: optStr(80),
      ram_gb: z.number().min(0.5).max(4096).nullish(),
      accel: z.enum(['cuda', 'metal', 'cpu', 'other']).nullish(),
    })
    .nullish(),
  browser: z
    .object({
      user_agent: optStr(300),
      cores: z.number().int().min(1).max(1024).nullish(),
      device_memory_gb: z.number().min(0.1).max(1024).nullish(),
    })
    .nullish(),
});
const BackendToggleBodySchema = z.object({ enabled: z.boolean() });
// Abuse guard for the participant-facing writes: each call fans out to 3 outbound probes.
const BACKEND_WRITE_RATE = { rateLimit: { max: 30, timeWindow: '1 minute' } };

/** What a runner may POST as the cell bundle (contract: application/gzip). */
const BUNDLE_CONTENT_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream'];

const WorldStartSchema = z.object({
  objective: z.string().optional(),
  bots: z.number().int().min(0).max(50).optional(),
  foodCount: z.number().int().min(1).max(100).optional(),
});

export async function setupRoutes(
  app: FastifyInstance,
  hub: WebSocketHub,
  roundManager: RoundManager,
  voteManager: VoteManager,
  metricsManager: MetricsManager,
  worldEngine: WorldEngine,
  eventLogger?: EventLogger,
  bench?: { engine: BenchEngine; store: BenchStore; dataDir: string; backends?: BackendRegistry }
) {
  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // ============ WORLD MODE (2D agent arena) ============

  // Start / configure the agent world (optionally spawn demo bots)
  app.post('/world/start', async (request) => {
    const body = WorldStartSchema.parse(request.body ?? {});
    // Attach world events to the active session so they land in the exports.
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    worldEngine.start({ ...body, sessionId: session?.id });
    return { status: 'ok', running: true };
  });

  // Stop the agent world and clear it
  app.post('/world/stop', async () => {
    worldEngine.stop();
    return { status: 'ok', running: false };
  });

  // Current world snapshot (debugging / polling fallback)
  app.get('/world/state', async () => {
    return worldEngine.snapshot();
  });


  // ============ BENCH MODE (tau-intent runner x arms A/B/C) ============
  // Contract: docs/BENCH-V0-CONTRACT.md §3. Owner endpoints are unauthenticated like /world/*.
  if (bench) {
    const { engine, store, dataDir } = bench;

    const activeSessionId = async (): Promise<string | null> => {
      const session = await app.prisma.session.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      return session?.id ?? null;
    };

    const fail = (reply: FastifyReply, err: unknown) => {
      if (err instanceof BenchError) {
        return reply.code(err.httpStatus).send({ error: err.code, message: err.message, details: err.details });
      }
      throw err;
    };

    // Assign arms/mode to one participant. Stored; sent now if the bench is running and the
    // runner is idle, otherwise on /bench/start.
    app.post('/bench/assign', async (request, reply) => {
      const parsed = BenchAssignBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      const sessionId = await activeSessionId();
      if (!sessionId) return reply.code(409).send({ error: 'no_active_session' });
      const b = parsed.data;
      try {
        const r = await engine.assign(sessionId, {
          participantId: b.participant_id,
          arms: b.arms,
          mode: b.mode,
          seed: b.seed,
          kMax: b.k_max,
          deadlineS: b.deadline_s,
          maxProductiveTurns: b.max_productive_turns,
        });
        return { status: 'ok', ...r };
      } catch (err) {
        return fail(reply, err);
      }
    });

    app.post('/bench/start', async (request, reply) => {
      const parsed = BenchStartBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      const sessionId = await activeSessionId();
      if (!sessionId) return reply.code(409).send({ error: 'no_active_session' });
      try {
        const r = await engine.start(sessionId, {
          mode: parsed.data.mode,
          onlyQualified: parsed.data.only_qualified,
          participantIds: parsed.data.participant_ids,
        });
        return { status: 'ok', ...r };
      } catch (err) {
        return fail(reply, err);
      }
    });

    app.post('/bench/stop', async (request, reply) => {
      const parsed = BenchStopBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      const sessionId = await activeSessionId();
      if (!sessionId) return reply.code(409).send({ error: 'no_active_session' });
      try {
        const r = await engine.stop(sessionId, { participantId: parsed.data.participant_id });
        return { status: 'ok', ...r };
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Full state (telão/control hydration and polling fallback)
    app.get('/bench/state', async () => engine.state(await activeSessionId()));

    // ---- V0.2: model backends (a participant's Ollama, probed over the LAN) ----
    const backends = bench.backends;
    if (backends) {
      /** Runner status per backend: a WS runner registered with participant_id === backend_id. */
      const runnerViews = async (): Promise<(id: string) => RunnerView> => {
        const state = (await engine.state(await activeSessionId())) as { participants: Array<{ participant_id: string; cell: { cell_id: string; status: string; records: number } | null }> };
        const byId = new Map(state.participants.map((p) => [p.participant_id, p]));
        return (id) => {
          const connected = hub.isParticipantConnected(id);
          const cell = byId.get(id)?.cell ?? null;
          const active = !!cell && ['sent', 'running', 'stopping'].includes(cell.status);
          return {
            connected,
            status: !connected ? 'waiting' : active ? 'running' : 'connected',
            cell_id: cell?.cell_id ?? null,
            cell_status: cell?.status ?? null,
            records: cell?.records ?? 0,
          };
        };
      };
      const viewOf = async (b: StoredBackend, request: Parameters<typeof isLoopbackRequest>[0]) =>
        backendView(b, { rawHost: isLoopbackRequest(request), runner: (await runnerViews())(b.id) });

      // Register (or update) the caller's Ollama. The HOST is the request's remote address, never the body.
      app.post('/bench/backends', { config: BACKEND_WRITE_RATE }, async (request, reply) => {
        const parsed = BackendRegisterBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
        const b = parsed.data;
        try {
          const { backend, created } = await backends.register(
            {
              nickname: b.nickname,
              model: b.model,
              port: b.port,
              declaredHardware: b.declared_hardware
                ? { chip: b.declared_hardware.chip ?? null, ram_gb: b.declared_hardware.ram_gb ?? null, accel: b.declared_hardware.accel ?? null }
                : null,
              browser: b.browser
                ? { user_agent: b.browser.user_agent ?? null, cores: b.browser.cores ?? null, device_memory_gb: b.browser.device_memory_gb ?? null }
                : null,
            },
            resolveClientHost(request)
          );
          return reply.code(created ? 201 : 200).send({ created, ...(await viewOf(backend, request)) });
        } catch (err) {
          if (err instanceof BackendError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
          throw err;
        }
      });

      // Every backend. `provider_url` (raw host) only for loopback callers; others get `host_sha256` only.
      app.get('/bench/backends', async (request) => {
        const raw = isLoopbackRequest(request);
        const runnerOf = await runnerViews();
        const list = await backends.list();
        return {
          t: Date.now(),
          raw_host_visible: raw,
          join_urls: lanJoinUrls(parseInt(process.env.PORT || '3000', 10)),
          backends: list.map((x) => backendView(x, { rawHost: raw, runner: runnerOf(x.id) })),
        };
      });

      app.get('/bench/backends/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const b = await backends.get(id);
        if (!b) return reply.code(404).send({ error: 'unknown_backend' });
        return viewOf(b, request);
      });

      app.post('/bench/backends/:id/probe', { config: BACKEND_WRITE_RATE }, async (request, reply) => {
        const { id } = request.params as { id: string };
        try {
          return await viewOf(await backends.reprobe(id), request);
        } catch (err) {
          if (err instanceof BackendError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
          throw err;
        }
      });

      app.post('/bench/backends/:id', { config: BACKEND_WRITE_RATE }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = BackendToggleBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
        try {
          return await viewOf(await backends.setEnabled(id, parsed.data.enabled), request);
        } catch (err) {
          if (err instanceof BackendError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
          throw err;
        }
      });
    }

    // ---- artifacts: the cell bundle (gzip tar) ----
    // The body is streamed to disk, never buffered: register a parser that hands the raw stream over.
    app.addContentTypeParser(BUNDLE_CONTENT_TYPES, (_req, payload, done) => done(null, payload));

    app.post(
      '/bench/artifacts/:cellId',
      // Runners upload a few large bundles (and retry); not a polling client.
      { bodyLimit: MAX_BUNDLE_BYTES, config: { rateLimit: false } },
      async (request, reply) => {
        const { cellId } = request.params as { cellId: string };
        if (!CELL_ID_RE.test(cellId)) return reply.code(400).send({ error: 'invalid_cell_id' });
        const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!BUNDLE_CONTENT_TYPES.includes(contentType)) {
          return reply.code(415).send({ error: 'unsupported_media_type', accepted: BUNDLE_CONTENT_TYPES });
        }
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
          reply.header('connection', 'close');
          return reply.code(413).send({ error: 'too_large', max_bytes: MAX_BUNDLE_BYTES });
        }
        const cell = await engine.findCell(cellId);
        if (!cell) {
          reply.header('connection', 'close');
          return reply.code(404).send({ error: 'unknown_cell', message: 'No bench_assign was ever sent for this cell id' });
        }
        // Optional hardening: the runner may identify itself and/or declare the sha256 it computed.
        const who = request.headers['x-participant-id'];
        if (typeof who === 'string' && who !== cell.participantId) {
          reply.header('connection', 'close');
          return reply.code(403).send({ error: 'participant_mismatch' });
        }
        const sha = request.headers['x-bench-sha256'];
        try {
          const { artifact, duplicate } = await storeBundle({
            store,
            dataDir,
            sessionId: cell.sessionId,
            cellId,
            participantId: cell.participantId,
            body: request.body as Readable,
            expectedSha256: typeof sha === 'string' ? sha : undefined,
          });
          engine.noteArtifact(artifact, duplicate);
          return reply.code(duplicate ? 200 : 201).send({
            status: 'ok',
            cell_id: cellId,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
            version: artifact.version,
            path: artifact.path,
            duplicate,
          });
        } catch (err) {
          if (err instanceof BundleError) {
            reply.header('connection', 'close');
            return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
          }
          throw err;
        }
      }
    );

    // List of stored bundles (all versions) with sha256
    app.get('/bench/artifacts', async (request, reply) => {
      const q = request.query as { session_id?: string };
      const sessionId = q.session_id || (await activeSessionId());
      if (!sessionId) return reply.code(404).send({ error: 'No active session' });
      const rows = await store.listArtifacts(sessionId);
      const latest = new Map<string, number>();
      for (const a of rows) latest.set(a.cellId, Math.max(latest.get(a.cellId) ?? 0, a.version));
      return {
        session_id: sessionId,
        artifacts: rows.map((a) => ({
          cell_id: a.cellId,
          participant_id: a.participantId,
          version: a.version,
          latest: latest.get(a.cellId) === a.version,
          path: a.path,
          sha256: a.sha256,
          bytes: a.bytes,
          uploaded_at: a.createdAt.toISOString(),
        })),
      };
    });

    // Download one bundle (latest, or ?version=n)
    app.get('/bench/artifacts/:cellId', async (request, reply) => {
      const { cellId } = request.params as { cellId: string };
      const { version } = request.query as { version?: string };
      if (!CELL_ID_RE.test(cellId)) return reply.code(400).send({ error: 'invalid_cell_id' });
      const wanted = version != null ? Number(version) : undefined;
      if (wanted != null && !Number.isInteger(wanted)) return reply.code(400).send({ error: 'invalid_version' });
      const rows = await store.getArtifact(cellId, wanted);
      if (!rows) return reply.code(404).send({ error: 'no_artifact' });
      const file = path.resolve(dataDir, rows.path);
      if (!file.startsWith(path.resolve(dataDir) + path.sep) || !fs.existsSync(file)) {
        return reply.code(404).send({ error: 'file_missing' });
      }
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
      reply.header('X-Bench-Sha256', rows.sha256);
      return reply.send(fs.createReadStream(file));
    });

    // One record per line, as received (raw JSON). ?session_id= for a past session,
    // ?envelope=1 wraps each line with the arena's own columns (receivedAt, ids).
    app.get('/export-bench.jsonl', async (request, reply) => {
      const q = request.query as { session_id?: string; envelope?: string };
      const sessionId = q.session_id || (await activeSessionId());
      if (!sessionId) return reply.code(404).send({ error: 'No active session' });
      const records = await store.loadRecords(sessionId);
      const lines = records.map((r) =>
        q.envelope === '1' || q.envelope === 'true'
          ? JSON.stringify({
              session_id: r.sessionId,
              cell_id: r.cellId,
              participant_id: r.participantId,
              received_at: r.receivedAt.toISOString(),
              record: JSON.parse(r.raw),
            })
          : r.raw
      );
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="bench-${sessionId}.jsonl"`);
      return lines.length ? lines.join('\n') + '\n' : '';
    });
  }

  // Get active session
  app.get('/session', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      include: {
        participants: true,
        rounds: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    // Don't return PIN hash, but keep plain PIN for admin
    const { pinHash, ...sessionData } = session;

    return sessionData;
  });

  // Get live presence (authoritative source for connected participants)
  // Uses in-memory connection state instead of database for accuracy
  app.get('/presence', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    // Get live connections from memory (authoritative source)
    const liveConnections = hub.getLiveConnectedParticipants();

    // Filter to current session only
    const sessionParticipantIds = liveConnections
      .filter((c) => c.sessionId === session.id)
      .map((c) => c.participantId);

    // Fetch full participant data for connected participants only
    const participants = await app.prisma.participant.findMany({
      where: {
        id: { in: sessionParticipantIds },
        sessionId: session.id,
      },
      select: {
        id: true,
        nickname: true,
        runner: true,
        model: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Add live connection info
    const participantsWithStatus = participants.map((p) => {
      const liveConn = liveConnections.find((c) => c.participantId === p.id);
      return {
        ...p,
        connected: true, // Always true since we filtered by live connections
        lastSeen: liveConn?.lastSeen.toISOString(),
      };
    });

    return {
      sessionId: session.id,
      connectedCount: participantsWithStatus.length,
      participants: participantsWithStatus,
    };
  });

  // Get current round
  app.get('/rounds/current', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    const round = await roundManager.getCurrentRound(session.id);

    if (!round) {
      return reply.code(404).send({ error: 'No active round' });
    }

    // Get live tokens
    const tokens = await hub.getCurrentRoundTokens(round.index);

    return {
      ...round,
      liveTokens: Object.fromEntries(tokens),
    };
  });

  // Get scoreboard
  app.get('/scoreboard', async (request, reply) => {
    const query = request.query as { roundId?: string };

    let roundId = query.roundId;

    if (!roundId) {
      const session = await app.prisma.session.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });

      if (!session) {
        return reply.code(404).send({ error: 'No active session' });
      }

      // Try to get the most recently ended round first, then active round
      let round = await app.prisma.round.findFirst({
        where: {
          sessionId: session.id,
          endedAt: { not: null },
        },
        orderBy: { index: 'desc' },
      });

      if (!round) {
        round = await roundManager.getCurrentRound(session.id);
      }

      if (!round) {
        return reply.code(404).send({ error: 'No round found' });
      }

      roundId = round.id;
    }

    const scoreboard = await voteManager.getScoreboard(roundId);

    return scoreboard;
  });

  // Get metrics
  app.get('/metrics', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    const metrics = await metricsManager.getSessionMetrics(session.id);

    return metrics;
  });

  // Export CSV
  app.get('/export.csv', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    const csv = await metricsManager.exportToCSV(session.id);

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="session-${session.id}.csv"`);

    return csv;
  });

  // Create session
  app.post('/session', async (request, reply) => {
    const body = CreateSessionSchema.parse(request.body);

    // Generate PIN
    const pin = Math.random()
      .toString()
      .slice(2, 2 + body.pinLength)
      .padStart(body.pinLength, '0');
    const pinHash = await bcrypt.hash(pin, 10);

    // Disconnect all participants from previous session
    const disconnectedCount = hub.disconnectAllParticipants('Nova sessão criada. Reconecte com o novo PIN.');

    // Mark all participants as disconnected in the database
    await app.prisma.participant.updateMany({
      data: { connected: false },
    });

    // End previous active sessions
    await app.prisma.session.updateMany({
      where: { status: 'active' },
      data: { status: 'ended' },
    });

    // Create new session
    const session = await app.prisma.session.create({
      data: {
        pin,     // Store plain PIN for admin display
        pinHash, // Store hash for verification
        status: 'active',
      },
    });

    app.log.info({ sessionId: session.id, pin, disconnectedCount }, 'Session created');

    // Log event for research
    await eventLogger?.log({
      sessionId: session.id,
      eventType: 'session_created',
      actorType: 'admin',
      targetType: 'session',
      targetId: session.id,
      metadata: { disconnectedPreviousParticipants: disconnectedCount },
    });

    return {
      session_id: session.id,
      pin, // Only return PIN on creation
      created_at: session.createdAt,
      disconnected_participants: disconnectedCount,
    };
  });

  // Create round
  app.post('/rounds', async (request, reply) => {
    const body = CreateRoundSchema.parse(request.body);

    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    const round = await roundManager.createRound({
      sessionId: session.id,
      ...body,
    });

    return round;
  });

  // Start round
  app.post('/rounds/start', async (request, reply) => {
    const body = StartRoundSchema.parse(request.body);

    const round = await roundManager.startRound(body.roundId);

    return round;
  });

  // Stop round
  app.post('/rounds/stop', async (request, reply) => {
    const body = StopRoundSchema.parse(request.body);

    // Rescue participants whose `complete` never arrived: persist their
    // buffered tokens as metrics so they show up in the voting page.
    // Nunca deixe esse resgate impedir a parada da rodada: ao vivo, parar
    // é a operação crítica, o resgate é o bônus.
    try {
      const flushed = await hub.flushPendingMetrics(body.roundId);
      if (flushed > 0) {
        app.log.warn({ roundId: body.roundId, flushed }, 'Persisted metrics from token buffer at round stop');
      }
    } catch (error) {
      app.log.error({ error, roundId: body.roundId }, 'Flush of buffered metrics failed, stopping round anyway');
    }

    const round = await roundManager.stopRound(body.roundId);

    return round;
  });

  // Cast vote
  app.post('/votes', async (request, reply) => {
    const body = CastVoteSchema.parse(request.body);

    // Use provided voterId or fall back to IP
    const voterId = body.voterId || request.ip;
    // Get user agent from request headers if not provided
    const userAgent = body.userAgent || request.headers['user-agent'];

    try {
      const vote = await voteManager.castVote({
        roundId: body.roundId,
        voterId,
        participantId: body.participantId,
        score: body.score,
        responseTime: body.responseTime,
        userAgent,
      });

      return vote;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cast vote';
      return reply.code(400).send({ error: message });
    }
  });

  // Get voted participants for a voter
  app.get('/votes/mine', async (request, reply) => {
    const query = GetVotedSchema.parse(request.query);

    const votes = await voteManager.getVotedParticipants(query.roundId, query.voterId);

    return votes;
  });

  // Close voting for a round
  app.post('/rounds/:roundId/close-voting', async (request, reply) => {
    const { roundId } = request.params as { roundId: string };

    try {
      const round = await roundManager.closeVoting(roundId);
      return round;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close voting';
      return reply.code(400).send({ error: message });
    }
  });

  // Start reveal ceremony
  app.post('/rounds/:roundId/reveal', async (request, reply) => {
    const { roundId } = request.params as { roundId: string };

    try {
      const round = await roundManager.startReveal(roundId);
      return round;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start reveal';
      return reply.code(400).send({ error: message });
    }
  });

  // Reveal next position
  app.post('/rounds/:roundId/reveal-next', async (request, reply) => {
    const { roundId } = request.params as { roundId: string };

    try {
      const round = await roundManager.revealNext(roundId);
      return round;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reveal next';
      return reply.code(400).send({ error: message });
    }
  });

  // Get responses for voting
  app.get('/rounds/:roundId/responses', async (request, reply) => {
    const { roundId } = request.params as { roundId: string };

    try {
      const responses = await voteManager.getRoundResponses(roundId);
      return responses;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get responses';
      return reply.code(400).send({ error: message });
    }
  });

  // Kick participant
  app.post('/participants/kick', async (request, reply) => {
    const body = KickParticipantSchema.parse(request.body);

    await app.prisma.participant.delete({
      where: { id: body.participantId },
    });

    return { status: 'ok' };
  });

  // Export events as CSV for research
  app.get('/export-events.csv', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    const events = await app.prisma.eventLog.findMany({
      where: { sessionId: session.id },
      orderBy: { timestamp: 'asc' },
    });

    // Build CSV
    const headers = ['id', 'timestamp', 'eventType', 'actorType', 'actorId', 'targetType', 'targetId', 'metadata'];
    const rows = events.map((e) => [
      e.id,
      e.timestamp.toISOString(),
      e.eventType,
      e.actorType,
      e.actorId || '',
      e.targetType || '',
      e.targetId || '',
      e.metadata || '',
    ].map((val) => `"${String(val).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="events-${session.id}.csv"`);

    return csv;
  });

  // Export all session data as JSON for research
  app.get('/export-all.json', async (request, reply) => {
    const session = await app.prisma.session.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
      include: {
        participants: true,
        rounds: {
          include: {
            metrics: true,
            votes: true,
          },
        },
        events: {
          orderBy: { timestamp: 'asc' },
        },
      },
    });

    if (!session) {
      return reply.code(404).send({ error: 'No active session' });
    }

    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="session-${session.id}-full.json"`);

    // V0.2 backends: hashed host only (backendExportRow has no host field).
    const benchBackends = bench?.backends ? (await bench.backends.list()).map(backendExportRow) : undefined;
    return benchBackends ? { ...session, benchBackends } : session;
  });
}

