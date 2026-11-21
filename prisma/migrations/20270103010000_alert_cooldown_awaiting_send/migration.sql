-- #5255: the once-ever alert sweep (INV-INT-042). Expand only: two nullable
-- columns with no default, so the deployed release, which never names them,
-- keeps reading and writing AlertCooldown as before. A claim that release
-- takes leaves "awaitingSendSince" null, so the sweep never gives it back.

-- AlterTable
ALTER TABLE "AlertCooldown" ADD COLUMN "awaitingSendSince" TIMESTAMP(3);
ALTER TABLE "AlertCooldown" ADD COLUMN "replayAlert" JSONB;
