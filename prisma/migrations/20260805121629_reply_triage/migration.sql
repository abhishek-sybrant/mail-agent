-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN "handled_action" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "handled_at" DATETIME;
