-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "schedule_note" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "schedule_state" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "scheduled_end" DATETIME;
ALTER TABLE "Campaign" ADD COLUMN "scheduled_start" DATETIME;
