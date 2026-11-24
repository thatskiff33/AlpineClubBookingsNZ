-- #5246: expand-only. Two nullable markers for a message-board share whose
-- outcome was not recorded; the deployed release neither reads nor writes them.
ALTER TABLE "ClubPost" ADD COLUMN "shareSentAt" TIMESTAMP(3);
ALTER TABLE "ClubPost" ADD COLUMN "unrecordedServerPostId" VARCHAR(64);
