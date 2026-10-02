-- CreateTable
CREATE TABLE "bench_backends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "declaredHardware" TEXT,
    "browser" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reachable" BOOLEAN NOT NULL DEFAULT false,
    "ollamaVersion" TEXT,
    "digest" TEXT,
    "details" TEXT,
    "problems" TEXT NOT NULL DEFAULT '[]',
    "lastProbeAt" DATETIME,
    "hostSha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "bench_backends_hostSha256_idx" ON "bench_backends"("hostSha256");

-- CreateIndex
CREATE UNIQUE INDEX "bench_backends_host_port_model_key" ON "bench_backends"("host", "port", "model");
