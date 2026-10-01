import type { PrismaClient } from '@prisma/client';
import type { BenchArm, BenchJoinMessage, BenchMode } from '../ws/schemas.js';

/**
 * Persistence boundary of the bench engine. The engine only talks to this
 * interface, so it can be unit-tested with MemoryBenchStore and runs on
 * PrismaBenchStore (SQLite) in the server.
 */

export type BenchCellStatus =
  | 'planned' // owner's choice, not sent yet
  | 'sent' // bench_assign delivered, runner has not reported yet
  | 'running'
  | 'stopping' // bench_stop sent, waiting for bench_cell_done
  | 'done'
  | 'stopped' // finished truncated (stop, runner truncation, or runner gone at stop)
  | 'error'; // runner refused/failed before running anything

export interface StoredCell {
  cellId: string;
  sessionId: string;
  participantId: string;
  mode: BenchMode;
  arms: BenchArm[];
  armsSource: 'owner' | 'default_shuffled';
  seed: number;
  kMax: number;
  deadlineS: number;
  maxProductiveTurns: number;
  status: BenchCellStatus;
  join: BenchJoinMessage | null;
  summary: unknown | null;
  createdAt: Date;
  sentAt: Date | null;
  doneAt: Date | null;
}

export interface StoredRecord {
  cellId: string;
  sessionId: string;
  participantId: string;
  armId: string;
  taskIndex: number;
  oraclePass: boolean | null;
  tokensIn: number | null;
  tokensOut: number | null;
  terminatedBy: string;
  receivedAt: Date;
  rawSha256: string;
  raw: string;
}

export interface StoredArtifact {
  cellId: string;
  sessionId: string;
  participantId: string | null;
  path: string; // relative to the bench data dir
  sha256: string;
  bytes: number;
  version: number;
  createdAt: Date;
}

export interface BenchStore {
  loadCells(sessionId: string): Promise<StoredCell[]>;
  findCell(cellId: string): Promise<StoredCell | null>;
  upsertCell(cell: StoredCell): Promise<void>;
  loadRecords(sessionId: string): Promise<StoredRecord[]>;
  insertRecord(rec: StoredRecord): Promise<'inserted' | 'duplicate'>;
  listArtifacts(sessionId: string): Promise<StoredArtifact[]>;
  latestArtifact(cellId: string): Promise<StoredArtifact | null>;
  getArtifact(cellId: string, version?: number): Promise<StoredArtifact | null>;
  addArtifact(a: StoredArtifact): Promise<void>;
  setArtifactPath(cellId: string, version: number, path: string): Promise<void>;
}

// ---------------------------------------------------------------- Prisma

type CellRow = Awaited<ReturnType<PrismaClient['benchAssignment']['findMany']>>[number];

function parseJson<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function rowToCell(r: CellRow): StoredCell {
  return {
    cellId: r.cellId,
    sessionId: r.sessionId,
    participantId: r.participantId,
    mode: r.mode as BenchMode,
    arms: parseJson<BenchArm[]>(r.arms) ?? [],
    armsSource: r.armsSource as StoredCell['armsSource'],
    seed: r.seed,
    kMax: r.kMax,
    deadlineS: r.deadlineS,
    maxProductiveTurns: r.maxProductiveTurns,
    status: r.status as BenchCellStatus,
    join: parseJson<BenchJoinMessage>(r.joinInfo),
    summary: parseJson<unknown>(r.summary),
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    doneAt: r.doneAt,
  };
}

export class PrismaBenchStore implements BenchStore {
  constructor(private prisma: PrismaClient) {}

  async loadCells(sessionId: string) {
    const rows = await this.prisma.benchAssignment.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    return rows.map(rowToCell);
  }

  async findCell(cellId: string) {
    const r = await this.prisma.benchAssignment.findUnique({ where: { cellId } });
    return r ? rowToCell(r) : null;
  }

  async upsertCell(c: StoredCell) {
    const data = {
      participantId: c.participantId,
      mode: c.mode,
      arms: JSON.stringify(c.arms),
      armsSource: c.armsSource,
      seed: c.seed,
      kMax: c.kMax,
      deadlineS: c.deadlineS,
      maxProductiveTurns: c.maxProductiveTurns,
      status: c.status,
      joinInfo: c.join ? JSON.stringify(c.join) : null,
      summary: c.summary != null ? JSON.stringify(c.summary) : null,
      sentAt: c.sentAt,
      doneAt: c.doneAt,
    };
    await this.prisma.benchAssignment.upsert({
      where: { cellId: c.cellId },
      create: { cellId: c.cellId, sessionId: c.sessionId, createdAt: c.createdAt, ...data },
      update: data,
    });
  }

  async loadRecords(sessionId: string) {
    return this.prisma.benchRecord.findMany({ where: { sessionId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
  }

  async insertRecord(rec: StoredRecord) {
    try {
      await this.prisma.benchRecord.create({ data: rec });
      return 'inserted' as const;
    } catch (err) {
      // Unique (cellId, rawSha256): the runner retried an identical record.
      if ((err as { code?: string }).code === 'P2002') return 'duplicate' as const;
      throw err;
    }
  }

  async listArtifacts(sessionId: string) {
    return this.prisma.benchArtifact.findMany({ where: { sessionId }, orderBy: [{ createdAt: 'asc' }, { version: 'asc' }] });
  }

  async latestArtifact(cellId: string) {
    return this.prisma.benchArtifact.findFirst({ where: { cellId }, orderBy: { version: 'desc' } });
  }

  async getArtifact(cellId: string, version?: number) {
    return version == null
      ? this.latestArtifact(cellId)
      : this.prisma.benchArtifact.findUnique({ where: { cellId_version: { cellId, version } } });
  }

  async addArtifact(a: StoredArtifact) {
    await this.prisma.benchArtifact.create({ data: a });
  }

  async setArtifactPath(cellId: string, version: number, path: string) {
    await this.prisma.benchArtifact.update({ where: { cellId_version: { cellId, version } }, data: { path } });
  }
}

// ---------------------------------------------------------------- Memory (tests)

export class MemoryBenchStore implements BenchStore {
  cells = new Map<string, StoredCell>();
  records: StoredRecord[] = [];
  artifacts: StoredArtifact[] = [];

  async loadCells(sessionId: string) {
    return [...this.cells.values()].filter((c) => c.sessionId === sessionId).map((c) => ({ ...c }));
  }
  async findCell(cellId: string) {
    const c = this.cells.get(cellId);
    return c ? { ...c } : null;
  }
  async upsertCell(c: StoredCell) {
    this.cells.set(c.cellId, { ...c });
  }
  async loadRecords(sessionId: string) {
    return this.records.filter((r) => r.sessionId === sessionId);
  }
  async insertRecord(rec: StoredRecord) {
    if (this.records.some((r) => r.cellId === rec.cellId && r.rawSha256 === rec.rawSha256)) return 'duplicate' as const;
    this.records.push({ ...rec });
    return 'inserted' as const;
  }
  async listArtifacts(sessionId: string) {
    return this.artifacts.filter((a) => a.sessionId === sessionId);
  }
  async latestArtifact(cellId: string) {
    const all = this.artifacts.filter((a) => a.cellId === cellId).sort((x, y) => y.version - x.version);
    return all[0] ?? null;
  }
  async getArtifact(cellId: string, version?: number) {
    if (version == null) return this.latestArtifact(cellId);
    return this.artifacts.find((a) => a.cellId === cellId && a.version === version) ?? null;
  }
  async addArtifact(a: StoredArtifact) {
    this.artifacts.push({ ...a });
  }
  async setArtifactPath(cellId: string, version: number, path: string) {
    const a = this.artifacts.find((x) => x.cellId === cellId && x.version === version);
    if (a) a.path = path;
  }
}
