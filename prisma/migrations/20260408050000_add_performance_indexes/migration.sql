-- Add performance indexes for frequently queried fields

-- Member.canLogin: used in auth/login queries
CREATE INDEX IF NOT EXISTS "Member_canLogin_idx" ON "Member"("canLogin");

-- Member.active: used in deactivation checks and member listing
CREATE INDEX IF NOT EXISTS "Member_active_idx" ON "Member"("active");

-- PromoCode.active: used in promo validation queries
CREATE INDEX IF NOT EXISTS "PromoCode_active_idx" ON "PromoCode"("active");
