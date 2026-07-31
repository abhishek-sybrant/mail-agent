-- CreateTable
CREATE TABLE "QmMailbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "workspace_id" TEXT,
    "synced_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
