CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "PasswordResetToken" ADD COLUMN "tokenHash" TEXT;
UPDATE "PasswordResetToken"
SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;
ALTER TABLE "PasswordResetToken" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX IF EXISTS "PasswordResetToken_token_key";
DROP INDEX IF EXISTS "PasswordResetToken_token_idx";
ALTER TABLE "PasswordResetToken" DROP COLUMN "token";
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

ALTER TABLE "EmailVerificationToken" ADD COLUMN "tokenHash" TEXT;
UPDATE "EmailVerificationToken"
SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;
ALTER TABLE "EmailVerificationToken" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX IF EXISTS "EmailVerificationToken_token_key";
DROP INDEX IF EXISTS "EmailVerificationToken_token_idx";
ALTER TABLE "EmailVerificationToken" DROP COLUMN "token";
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_tokenHash_idx" ON "EmailVerificationToken"("tokenHash");

ALTER TABLE "EmailChangeToken" ADD COLUMN "tokenHash" TEXT;
UPDATE "EmailChangeToken"
SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;
ALTER TABLE "EmailChangeToken" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX IF EXISTS "EmailChangeToken_token_key";
DROP INDEX IF EXISTS "EmailChangeToken_token_idx";
ALTER TABLE "EmailChangeToken" DROP COLUMN "token";
CREATE UNIQUE INDEX "EmailChangeToken_tokenHash_key" ON "EmailChangeToken"("tokenHash");
CREATE INDEX "EmailChangeToken_tokenHash_idx" ON "EmailChangeToken"("tokenHash");

ALTER TABLE "GuestChoreToken" ADD COLUMN "tokenHash" TEXT;
UPDATE "GuestChoreToken"
SET "tokenHash" = encode(digest("token", 'sha256'), 'hex')
WHERE "tokenHash" IS NULL;
ALTER TABLE "GuestChoreToken" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX IF EXISTS "GuestChoreToken_token_key";
DROP INDEX IF EXISTS "GuestChoreToken_token_idx";
ALTER TABLE "GuestChoreToken" DROP COLUMN "token";
CREATE UNIQUE INDEX "GuestChoreToken_tokenHash_key" ON "GuestChoreToken"("tokenHash");
CREATE INDEX "GuestChoreToken_tokenHash_idx" ON "GuestChoreToken"("tokenHash");
