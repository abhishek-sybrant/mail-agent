-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "template_id" TEXT,
    "quickmail_campaign_id" TEXT,
    "mailbox_ids" TEXT,
    "qm_paused" BOOLEAN,
    "qm_leads_total" INTEGER NOT NULL DEFAULT 0,
    "qm_sent" INTEGER NOT NULL DEFAULT 0,
    "qm_delivered" INTEGER NOT NULL DEFAULT 0,
    "qm_opens" INTEGER NOT NULL DEFAULT 0,
    "qm_clicks" INTEGER NOT NULL DEFAULT 0,
    "qm_replies" INTEGER NOT NULL DEFAULT 0,
    "qm_replies_pos" INTEGER NOT NULL DEFAULT 0,
    "qm_bounces" INTEGER NOT NULL DEFAULT 0,
    "qm_unsubscribes" INTEGER NOT NULL DEFAULT 0,
    "qm_app_url" TEXT,
    "synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Campaign_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "Template" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Campaign" ("created_at", "id", "mailbox_ids", "name", "quickmail_campaign_id", "status", "template_id", "updated_at") SELECT "created_at", "id", "mailbox_ids", "name", "quickmail_campaign_id", "status", "template_id", "updated_at" FROM "Campaign";
DROP TABLE "Campaign";
ALTER TABLE "new_Campaign" RENAME TO "Campaign";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
