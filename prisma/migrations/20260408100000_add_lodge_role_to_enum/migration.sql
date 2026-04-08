-- Add LODGE value to the Role enum.
-- This was added to schema.prisma in Phase 7 but never migrated to PostgreSQL.
-- Without it, the lodge kiosk account cannot be created or authenticated.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'LODGE';
