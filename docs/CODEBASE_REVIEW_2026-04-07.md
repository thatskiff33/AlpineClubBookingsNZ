# Outstanding Codebase Review Items

Remaining unresolved findings from the 2026-04-07 review.
Items verified as fixed/completed have been removed from this file as of 2026-04-15.

---

## HIGH ISSUES

### H2. Xero Credit Note Behavior Still Needs Real-Org Verification
**Files:** `src/lib/xero.ts:4513-4533`, `src/lib/xero.ts:4886-4906`, `src/lib/xero.ts:5443-5463`

**Impact:** Refund, account-credit, and modification credit notes still build positive `unitAmount` line items. That may be correct for Xero, but the repository does not contain evidence that this has been verified against the connected Xero org's ledger behavior. If the org behaves differently than expected, refunds could be posted incorrectly.

**Fix:** Verify refund/account-credit/modification credit notes end-to-end in a Xero demo or connected org and document the observed ledger behavior.
