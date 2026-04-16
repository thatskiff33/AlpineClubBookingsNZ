-- Add named-user finance access roles without broadening ADMIN.
CREATE TYPE "FinanceAccessLevel" AS ENUM ('NONE', 'VIEWER', 'MANAGER');

ALTER TABLE "Member"
ADD COLUMN "financeAccessLevel" "FinanceAccessLevel" NOT NULL DEFAULT 'NONE';
