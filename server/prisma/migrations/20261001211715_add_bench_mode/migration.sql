-- CreateTable
CREATE TABLE "bench_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "arms" TEXT NOT NULL,
    "armsSource" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "kMax" INTEGER NOT NULL,
    "deadlineS" INTEGER NOT NULL,
    "maxProductiveTurns" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "joinInfo" TEXT,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "doneAt" DATETIME,
    CONSTRAINT "bench_assignments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bench_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "armId" TEXT NOT NULL,
    "taskIndex" INTEGER NOT NULL,
    "oraclePass" BOOLEAN,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "terminatedBy" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawSha256" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    CONSTRAINT "bench_records_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bench_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "participantId" TEXT,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bench_artifacts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "bench_assignments_cellId_key" ON "bench_assignments"("cellId");

-- CreateIndex
CREATE INDEX "bench_assignments_sessionId_idx" ON "bench_assignments"("sessionId");

-- CreateIndex
CREATE INDEX "bench_assignments_participantId_idx" ON "bench_assignments"("participantId");

-- CreateIndex
CREATE INDEX "bench_records_sessionId_idx" ON "bench_records"("sessionId");

-- CreateIndex
CREATE INDEX "bench_records_cellId_idx" ON "bench_records"("cellId");

-- CreateIndex
CREATE INDEX "bench_records_participantId_idx" ON "bench_records"("participantId");

-- CreateIndex
CREATE INDEX "bench_records_armId_taskIndex_idx" ON "bench_records"("armId", "taskIndex");

-- CreateIndex
CREATE UNIQUE INDEX "bench_records_cellId_rawSha256_key" ON "bench_records"("cellId", "rawSha256");

-- CreateIndex
CREATE INDEX "bench_artifacts_sessionId_idx" ON "bench_artifacts"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "bench_artifacts_cellId_version_key" ON "bench_artifacts"("cellId", "version");
