-- CreateTable
CREATE TABLE "SuppressedDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "first_seen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedDomain_domain_key" ON "SuppressedDomain"("domain");

-- CreateIndex
CREATE INDEX "SuppressedDomain_reason_idx" ON "SuppressedDomain"("reason");
