-- AlterTable
ALTER TABLE "QmMailbox" ADD COLUMN "accredited" BOOLEAN;
ALTER TABLE "QmMailbox" ADD COLUMN "daily_quota" INTEGER;
ALTER TABLE "QmMailbox" ADD COLUMN "daily_sent" INTEGER;
ALTER TABLE "QmMailbox" ADD COLUMN "has_warmer" BOOLEAN;
ALTER TABLE "QmMailbox" ADD COLUMN "health_at" DATETIME;
ALTER TABLE "QmMailbox" ADD COLUMN "paused_reason" TEXT;
ALTER TABLE "QmMailbox" ADD COLUMN "score" INTEGER;
