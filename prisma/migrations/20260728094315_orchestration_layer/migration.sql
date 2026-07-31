-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "mailbox_ids" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "quickmail_campaign_id" TEXT;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN "sentiment" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "sentiment_score" INTEGER;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN "ai_prompt" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CampaignStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaign_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "template_id" TEXT,
    "wait_days" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignStep_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignStep_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "Template" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lead_id" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "payload" TEXT,
    "ai_draft" TEXT,
    "resolved_by" TEXT,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Approval_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Approval_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "company" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNCONTACTED',
    "ai_intent_score" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "quickmail_lead_id" TEXT,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppressed_reason" TEXT,
    "import_batch_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Lead_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Lead" ("ai_intent_score", "company", "created_at", "email", "id", "name", "status", "updated_at") SELECT "ai_intent_score", "company", "created_at", "email", "id", "name", "status", "updated_at" FROM "Lead";
DROP TABLE "Lead";
ALTER TABLE "new_Lead" RENAME TO "Lead";
CREATE UNIQUE INDEX "Lead_email_key" ON "Lead"("email");
CREATE INDEX "Lead_status_idx" ON "Lead"("status");
CREATE INDEX "Lead_suppressed_idx" ON "Lead"("suppressed");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CampaignStep_campaign_id_position_idx" ON "CampaignStep"("campaign_id", "position");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE INDEX "Approval_type_idx" ON "Approval"("type");

-- CreateIndex
CREATE INDEX "EmailLog_sentiment_idx" ON "EmailLog"("sentiment");
