-- AlterTable
ALTER TABLE "QmConversation" ADD COLUMN "forwarded_at" DATETIME;
ALTER TABLE "QmConversation" ADD COLUMN "forwarded_to" TEXT;
