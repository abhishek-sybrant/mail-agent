-- CreateTable
CREATE TABLE "QmConversation" (
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
    "qm_campaign_id" TEXT,
    "campaign_name" TEXT,
    "prospect_email" TEXT,
    "prospect_name" TEXT,
    "prospect_title" TEXT,
    "prospect_company" TEXT,
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "handled_at" DATETIME,
    "handled_action" TEXT,
    "synced_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QmConversation_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QmMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "subject" TEXT,
    "body_html" TEXT,
    "body_text" TEXT,
    "from_name" TEXT,
    "from_email" TEXT,
    "to_email" TEXT,
    "cc" TEXT,
    "sent_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QmMessage_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "QmConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QmConversation_handled_at_idx" ON "QmConversation"("handled_at");

-- CreateIndex
CREATE INDEX "QmConversation_lead_id_idx" ON "QmConversation"("lead_id");

-- CreateIndex
CREATE INDEX "QmMessage_conversation_id_sent_at_idx" ON "QmMessage"("conversation_id", "sent_at");
