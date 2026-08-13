-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_QmConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lead_id" TEXT,
    "subject" TEXT,
    "state" TEXT,
    "status" TEXT,
    "ai_summary" TEXT,
    "reply_type" TEXT,
    "is_ooo" BOOLEAN NOT NULL DEFAULT false,
    "waiting_since" DATETIME,
    "replyable_todo_id" TEXT,
    "inbox_id" TEXT,
    "inbox_email" TEXT,
    "inbox_name" TEXT,
    "qm_campaign_id" TEXT,
    "campaign_name" TEXT,
    "qm_prospect_id" TEXT,
    "prospect_email" TEXT,
    "prospect_name" TEXT,
    "prospect_title" TEXT,
    "prospect_company" TEXT,
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "handled_at" DATETIME,
    "handled_action" TEXT,
    "forwarded_at" DATETIME,
    "forwarded_to" TEXT,
    "forward_attempts" INTEGER NOT NULL DEFAULT 0,
    "forward_error" TEXT,
    "synced_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QmConversation_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_QmConversation" ("ai_summary", "campaign_name", "created_at", "do_not_contact", "forwarded_at", "forwarded_to", "handled_action", "handled_at", "id", "inbox_email", "inbox_id", "inbox_name", "is_ooo", "lead_id", "prospect_company", "prospect_email", "prospect_name", "prospect_title", "qm_campaign_id", "qm_prospect_id", "reply_type", "replyable_todo_id", "state", "status", "subject", "synced_at", "waiting_since") SELECT "ai_summary", "campaign_name", "created_at", "do_not_contact", "forwarded_at", "forwarded_to", "handled_action", "handled_at", "id", "inbox_email", "inbox_id", "inbox_name", "is_ooo", "lead_id", "prospect_company", "prospect_email", "prospect_name", "prospect_title", "qm_campaign_id", "qm_prospect_id", "reply_type", "replyable_todo_id", "state", "status", "subject", "synced_at", "waiting_since" FROM "QmConversation";
DROP TABLE "QmConversation";
ALTER TABLE "new_QmConversation" RENAME TO "QmConversation";
CREATE INDEX "QmConversation_handled_at_idx" ON "QmConversation"("handled_at");
CREATE INDEX "QmConversation_lead_id_idx" ON "QmConversation"("lead_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
