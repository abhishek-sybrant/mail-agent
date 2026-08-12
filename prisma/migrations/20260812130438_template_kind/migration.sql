-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FIRST_MAIL',
    "preview" TEXT,
    "ai_prompt" TEXT,
    "category" TEXT,
    "step" INTEGER,
    "source" TEXT,
    "geography" TEXT,
    "industry" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Template" ("ai_prompt", "body", "category", "created_at", "geography", "id", "industry", "name", "preview", "source", "step", "subject", "updated_at") SELECT "ai_prompt", "body", "category", "created_at", "geography", "id", "industry", "name", "preview", "source", "step", "subject", "updated_at" FROM "Template";
DROP TABLE "Template";
ALTER TABLE "new_Template" RENAME TO "Template";
CREATE INDEX "Template_kind_idx" ON "Template"("kind");

-- Backfill the new axis from the sequence position it used to be inferred from.
-- The imported .docx briefs are three-email sequences: step 1 is the opener and
-- steps 2 and 3 are the chasers. Everything else stays on the FIRST_MAIL
-- default, which is right for the hand-written and AI-generated one-offs that
-- never had a step.
UPDATE "Template" SET "kind" = 'FOLLOW_UP' WHERE "step" IS NOT NULL AND "step" >= 2;

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
