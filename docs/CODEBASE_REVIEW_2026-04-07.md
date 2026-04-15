# Outstanding Codebase Review Items

Remaining unresolved findings from the 2026-04-07 review.
Items verified as fixed/completed have been removed from this file as of 2026-04-15.

---

## HIGH ISSUES

### H2. Xero Credit Note Behavior Still Needs Real-Org Verification
**Files:** `src/lib/xero.ts:4513-4533`, `src/lib/xero.ts:4886-4906`, `src/lib/xero.ts:5443-5463`

**Impact:** Refund, account-credit, and modification credit notes still build positive `unitAmount` line items. That may be correct for Xero, but the repository does not contain evidence that this has been verified against the connected Xero org's ledger behavior. If the org behaves differently than expected, refunds could be posted incorrectly.

**Fix:** Verify refund/account-credit/modification credit notes end-to-end in a Xero demo or connected org and document the observed ledger behavior.

---

## MEDIUM ISSUES

### M7. Xero Membership Refresh Skips Members Without `xeroContactId`
**File:** `src/lib/xero.ts:3373-3379`

**Impact:** Members without a Xero contact ID still return `NOT_INVOICED` immediately and will not have their subscription status refreshed automatically. That may be an intentional design choice, but it is still undocumented in repo-facing documentation and there is no clear admin-facing warning for unlinked members.

**Fix:** Document this behavior and consider adding an admin warning for members without Xero links.

### M11. Email Inheritance Still Allows Chained Sources
**File:** `src/app/api/admin/members/[id]/route.ts:291-311`

**Impact:** Validation ensures the inheritance target exists and is an adult, but it still does not enforce a primary-member-only source or block chained inheritance graphs. That leaves room for circular or multi-hop email inheritance setups.

**Fix:** Require `inheritEmailFromId` sources to be primary adults (`parentMemberId == null`) and reject chain creation.

### M15. Token Cleanup Is Only Partially Automated
**File:** `src/instrumentation.ts:443-469`

**Impact:** A daily pruning job now removes expired email verification, email change, and guest chore tokens, but password reset pruning only deletes expired tokens where `used = true`. Expired unused password reset tokens can still accumulate.

**Fix:** Expand the pruning job to delete expired password reset tokens regardless of `used`, or apply an explicit retention policy.

---

## LOW ISSUES

### L1. Bumping Comment Still Says "FIFO" For Descending Order
**File:** `src/lib/bumping.ts:84,125-130`

**Impact:** The implementation matches the intended behavior (`createdAt DESC` means most recent pending bookings are bumped first), but the comment still describes that as FIFO. The code is correct; the comment is misleading.

**Fix:** Update the comment to describe the actual behavior directly: "last booked = first bumped" or "most recent pending bookings bumped first."

### L2. Advisory Lock ID Is Still Hardcoded To `1`
**Files:** `src/app/api/bookings/route.ts:436`, `src/app/api/bookings/[id]/modify-dates/route.ts:76`, `src/app/api/payments/create-payment-intent/route.ts:102`, `src/lib/waitlist.ts:83,197`

**Impact:** Booking writes, payment intent creation, and waitlist processing still share a single advisory lock key. At current lodge scale this is probably acceptable, but it serializes all protected write paths behind one lock and the design remains undocumented.

**Fix:** If the current serialization strategy is intentional, document it. If higher concurrency is needed later, split the lock key by resource or date range.
