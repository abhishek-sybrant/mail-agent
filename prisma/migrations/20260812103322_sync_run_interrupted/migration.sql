-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trigger" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" DATETIME,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "interrupted" BOOLEAN NOT NULL DEFAULT false,
    "parts" TEXT NOT NULL DEFAULT '[]',
    "lead_cursor" TEXT,
    "lead_done" INTEGER NOT NULL DEFAULT 0,
    "lead_total" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_SyncRun" ("finished_at", "id", "lead_cursor", "lead_done", "lead_total", "ok", "parts", "started_at", "trigger") SELECT "finished_at", "id", "lead_cursor", "lead_done", "lead_total", "ok", "parts", "started_at", "trigger" FROM "SyncRun";
DROP TABLE "SyncRun";
ALTER TABLE "new_SyncRun" RENAME TO "SyncRun";
CREATE INDEX "SyncRun_started_at_idx" ON "SyncRun"("started_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
