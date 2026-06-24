-- CreateEnum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Gender') THEN
    CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Title') THEN
    CREATE TYPE "Title" AS ENUM ('MR', 'MS', 'MRS', 'MISS', 'MASTER', 'DR', 'REV');
  END IF;
END$$;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "title" "Title";
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "gender" "Gender";
