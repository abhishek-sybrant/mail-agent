-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trigger" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" DATETIME,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "parts" TEXT NOT NULL DEFAULT '[]',
    "lead_cursor" TEXT,
    "lead_done" INTEGER NOT NULL DEFAULT 0,
    "lead_total" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "SyncRun_started_at_idx" ON "SyncRun"("started_at");
