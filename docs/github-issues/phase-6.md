## Phase 6: Xero & Modification Edge Cases

**Priority:** High/Medium — should complete before go-live
**Depends on:** None
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| H2 | High | Xero credit note amounts need verification against actual Xero behavior |
| M8 | Medium | Xero token refresh 5-minute buffer may be insufficient for bulk operations |
| M10 | Medium | Supplementary Xero invoices not linked to original invoice |
| M16 | Medium | Modification change fee uses original check-in date's cancellation policy |
| M7 | Medium | Membership refresh skips members without xeroContactId (undocumented) |

### Checklist

- [ ] **H2** — Verify Xero credit note behavior:
  - Create a test credit note in the Xero demo org and verify amounts appear correctly
  - If Xero expects positive amounts on credit notes (their API docs say they do), document this
  - If amounts are wrong, fix `src/lib/xero.ts:1466-1472` and `1616-1622`
- [ ] **M8** — Fix `src/lib/xero.ts:51`:
  - Increase `TOKEN_REFRESH_BUFFER_MS` from 5 minutes to 10 minutes
  - Add a comment documenting the rationale: bulk ops (contact sync, membership refresh) can take 5+ minutes
- [ ] **M10** — Fix `src/lib/xero.ts:1516-1582` (`createXeroSupplementaryInvoice`):
  - Add the original Xero invoice number to the supplementary invoice's `reference` field
  - Format: `"Supplementary to INV-XXXX for booking {bookingId}"`
  - Fetch the original invoice number from `payment.xeroInvoiceId` before creating the supplementary
- [ ] **M16** — Fix `src/app/api/bookings/[id]/modify-dates/route.ts:228-229`:
  - Document the business decision: should change fee use OLD or NEW check-in date's policy?
  - Current behavior uses OLD date — add explicit comment explaining this is intentional
  - OR change to use whichever policy is MORE restrictive (conservative approach)
  - Add a code comment either way
- [ ] **M7** — Fix `src/lib/xero.ts:1230-1231`:
  - Add a log.info at the start of membership refresh noting how many members have xeroContactId
  - Add a log.warn for the count of members WITHOUT xeroContactId who are skipped
  - This makes the limitation visible in logs without changing behavior
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 5 Xero and modification edge case issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 6).

1. src/lib/xero.ts:1466-1472 and 1616-1622 — Credit note amounts: Xero's API expects
   POSITIVE unitAmount values on credit notes (they handle the sign internally). Add a
   comment documenting this behavior at both credit note creation locations. No code change
   needed if amounts are already positive.

2. src/lib/xero.ts:51 — Increase TOKEN_REFRESH_BUFFER_MS from 5*60*1000 to 10*60*1000.
   Add comment: "10 min buffer accounts for long-running bulk operations (contact sync,
   membership refresh)."

3. src/lib/xero.ts createXeroSupplementaryInvoice (~line 1516-1582) — Add the original
   invoice number to the supplementary invoice's reference field. Look up the original
   invoice ID from the payment record and format as:
   "Supplementary to {xeroInvoiceId} for booking {bookingId.slice(0,8)}"

4. src/app/api/bookings/[id]/modify-dates/route.ts:228-229 — Add an explicit code comment
   documenting that the change fee is calculated using the ORIGINAL check-in date's
   cancellation policy, and explain why (the member's obligation was set at original
   booking time).

5. src/lib/xero.ts membership refresh (~line 1230) — Add logging at the start:
   log how many members have xeroContactId (will be refreshed) and how many don't
   (will be skipped). This makes the limitation visible without changing behavior.

After all changes: npm test && npm run build. Commit on branch: fix/phase-6-xero-edge-cases
```
