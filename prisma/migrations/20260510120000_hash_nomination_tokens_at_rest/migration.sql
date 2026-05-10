CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "NominationToken" ADD COLUMN "tokenHash" TEXT;
UPDATE "NominationToken"
SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;
ALTER TABLE "NominationToken" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX IF EXISTS "NominationToken_token_key";
DROP INDEX IF EXISTS "NominationToken_token_idx";
ALTER TABLE "NominationToken" DROP COLUMN "token";
CREATE UNIQUE INDEX "NominationToken_tokenHash_key" ON "NominationToken"("tokenHash");
CREATE INDEX "NominationToken_tokenHash_idx" ON "NominationToken"("tokenHash");
