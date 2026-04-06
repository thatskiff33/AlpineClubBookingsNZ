## Phase 7: Security Hardening

**Priority:** Medium/Low — should complete before go-live
**Depends on:** None
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| M13 | Medium | Sentry edge config missing `beforeSend` scrubbing hook |
| M14 | Medium | Session callback doesn't validate member is still active |
| H6 | High | Email verification token expiry times inconsistent (24h vs 1h vs 7d) |
| M11 | Medium | Email inheritance doesn't prevent circular chains |
| L8 | Low | HSTS max-age could be longer (1 year → 2 years) |
| L9 | Low | Docker container not read-only |

### Checklist

- [ ] **M13** — Fix `sentry.edge.config.ts`:
  - Add `beforeSend` hook matching `sentry.server.config.ts`
  - Scrub password, token, secret, authorization fields from error data
- [ ] **M14** — Add active-member check to key API routes:
  - `src/app/api/bookings/route.ts` (POST — booking creation)
  - `src/app/api/payments/create-payment-intent/route.ts`
  - Check `member.active === true`, return 403 if deactivated
  - Don't check on every API call — only on state-changing operations
- [ ] **H6** — Align token expiry strategy:
  - Document the rationale in a code comment in `src/lib/verification-tokens.ts`
  - Consider: verification 48h (was 24h), password reset 2h (was 1h), email change 2h (was 1h)
  - Admin invite: keep 7 days (new members may not check email immediately)
- [ ] **M11** — Fix `src/app/api/admin/members/[id]/route.ts:232-246`:
  - Add validation: `inheritEmailFromId` target must have `parentMemberId === null` (primary member only)
  - This prevents chains where dependent A inherits from dependent B
- [ ] **L8** — Fix `Caddyfile:8`:
  - Change `max-age=31536000` to `max-age=63072000` (2 years)
  - Keep `includeSubDomains`
- [ ] **L9** — Fix `docker-compose.yml` app service:
  - Add `read_only: true`
  - Add `tmpfs: ["/tmp"]`
  - Add `security_opt: ["no-new-privileges:true"]`
  - Test that the app still starts correctly with these restrictions
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`
- [ ] Test Docker: `docker compose build` (verify container starts with hardening)

### Agent Prompt

```
Fix 6 security hardening issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 7).

1. sentry.edge.config.ts — Add a beforeSend hook that scrubs sensitive fields from error
   events. Copy the pattern from sentry.server.config.ts (scrub password, token, secret,
   authorization from event.request.data and event.request.headers).

2. Add active-member validation to two key API routes:
   - src/app/api/bookings/route.ts (POST handler) — after auth check, verify the member
     record has active=true. Return 403 with error "Account deactivated" if not.
   - src/app/api/payments/create-payment-intent/route.ts — same check.
   This prevents deactivated members from creating bookings/payments during their remaining
   JWT session window.

3. src/lib/verification-tokens.ts — Add a code comment block at the top documenting the
   token expiry strategy:
   - Email verification: 48h (change from 24h — users may not check email same day)
   - Password reset: 2h (change from 1h — allows time for email delay)
   - Email change: 2h (change from 1h)
   - Admin invite: 7 days (unchanged)
   Update the actual expiry values to match.

4. src/app/api/admin/members/[id]/route.ts:232-246 — Add validation that the
   inheritEmailFromId target must have parentMemberId === null (must be a primary member).
   Return 400 if the target is itself a dependent.

5. Caddyfile:8 — Change HSTS max-age from 31536000 (1 year) to 63072000 (2 years).

6. docker-compose.yml — Add to the app service:
   read_only: true
   tmpfs:
     - /tmp
   security_opt:
     - no-new-privileges:true
   Verify the app still builds and starts correctly.

After all changes: npm test && npm run build && docker compose build.
Commit on branch: fix/phase-7-security-hardening
```
