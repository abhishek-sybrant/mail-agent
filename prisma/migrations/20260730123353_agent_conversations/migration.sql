-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "messages" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AgentConversation_updated_at_idx" ON "AgentConversation"("updated_at");
