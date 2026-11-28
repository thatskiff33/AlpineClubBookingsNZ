-- #5540: a Full Admin can unarchive a member. Expand only: one more lifecycle
-- action, recorded as an APPROVED request row so every archive and unarchive
-- stays on the member's history. Catalog-only, no table lock, no DML. The
-- draining release never writes it. PostgreSQL cannot drop an enum value; the
-- reverse is to leave it unused.
ALTER TYPE "MemberLifecycleAction" ADD VALUE IF NOT EXISTS 'UNARCHIVE';
