# Build Prompts: Phase 5 -- Member Auth Enhancements

---

## Security Review Required: YES

Both features involve authentication tokens, email verification gates, and email change flows. B3 gates booking creation on email verification -- bypass would allow unverified accounts to book. B2 involves email change with old-email notification and Xero contact updates. Review that: verification tokens are single-use with expiry, email verification cannot be bypassed on booking creation, email change notifies the old address, Xero contact email is updated atomically, and no token leakage in API responses.

---

### 5a. Build Prompt

```
Read CLAUDE.md, docs/DELIVERY_PLAN.md, and docs/requirements/01_ADMIN_AND_MEMBERS.md.
Build Phase 5 (Member Auth Enhancements) autonomously.

Features to build (in this order):

1. B3: Email verification on registration
   - Add `emailVerified Boolean @default(false)` to Member model in prisma/schema.prisma
   - Add `EmailVerificationToken` model: id (cuid), memberId (relation to Member),
     token (unique, random 64-char hex string), expiresAt (DateTime, 24h from creation),
     createdAt. Add @@index([token]).
   - Update registration route (`/api/auth/register`): after creating member, generate
     EmailVerificationToken, send verification email with link
     `/verify-email?token=<token>`. Do NOT set emailVerified=true on registration.
   - Create `GET /api/auth/verify-email?token=<token>` route: validates token exists,
     not expired, not already used. Sets `emailVerified=true` on member, deletes the
     token. Returns redirect to `/login?verified=true`.
   - Create `POST /api/auth/resend-verification` route: authenticated, rate-limited
     (3 per hour). Deletes any existing tokens for the member, creates a new one, sends
     email. Returns 200.
   - Create `/verify-email` page: reads token from query params, calls the verify API,
     shows success/error message with link to login.
   - Create resend verification UI: on login page, if login succeeds but emailVerified
     is false, show a message "Please verify your email" with a "Resend verification
     email" button. Do NOT create a session for unverified users -- return a specific
     error code (e.g. `{ error: "EMAIL_NOT_VERIFIED" }`) from the auth callback.
   - Gate booking creation: in `POST /api/bookings`, check `emailVerified === true`
     before proceeding. Return 403 with `{ error: "Email not verified" }` if false.
   - Grandfather existing members: add `@default(false)` to the schema field. Create a
     note in the migration that existing members should be bulk-updated to
     `emailVerified=true` via a SQL statement: `UPDATE "Member" SET "emailVerified" = true`.
     Add this as a comment in schema.prisma near the field.
   - Email template: use the existing branded template style from `email-templates.ts`.
     Subject: "Verify your email -- TAC Bookings". Body: greeting, verification link
     button, "This link expires in 24 hours", footer.
   - Run `npx prisma generate` after schema changes.

2. B2: Email change with verification
   - Add `EmailChangeToken` model: id (cuid), memberId (relation to Member),
     newEmail (String), token (unique, random 64-char hex string),
     expiresAt (DateTime, 1h from creation), createdAt. Add @@index([token]).
   - Create `POST /api/auth/request-email-change` route: authenticated, rate-limited
     (3 per hour). Validates new email (Zod, valid format, not same as current, not
     already taken by another member). Creates EmailChangeToken, sends verification
     email to the NEW address with link `/confirm-email-change?token=<token>`.
     Also sends notification to the OLD email: "Someone requested to change your
     email to <newEmail>. If this wasn't you, contact us."
   - Create `GET /api/auth/confirm-email-change?token=<token>` route: validates token
     exists, not expired. Updates member email to newEmail, deletes the token.
     If member has a xeroContactId, update the Xero contact email (guarded with
     isXeroConnected check, fire-and-forget -- log error but don't fail the change).
     Redirect to `/profile?emailChanged=true`.
   - Create `/confirm-email-change` page: reads token from query params, calls the
     confirm API, shows success/error message.
   - Add "Change Email" section on profile page: shows current email, input for new
     email, submit button. Calls the request-email-change API. Shows success toast
     "Verification email sent to <newEmail>".
   - Audit log both the request and the confirmation.
   - Email templates: branded style, two templates --
     (a) to new email: "Confirm your new email" with verification link button
     (b) to old email: "Email change requested" notification

Write tests for:
- Email verification flow: token generation, verification success, expired token,
  already-verified member, resend creates new token
- Email change flow: token generation, confirmation updates email, expired token,
  duplicate email rejection, old email notification sent
- Booking gate: unverified member blocked from booking creation
- Rate limiting on resend-verification and request-email-change

Run `npm test` and `npm run build` to verify everything passes.
Commit after each major milestone (B3 complete, B2 complete).
When done, push all commits.
```

---

### 5b. Review & Test Prompt

```
Read CLAUDE.md and docs/DELIVERY_PLAN.md. Review Phase 5 (Member Auth Enhancements) code.

Verify:
1. B3 - Email verification tokens:
   - Tokens are cryptographically random (crypto.randomBytes, not Math.random)
   - Tokens are single-use (deleted after verification)
   - 24h expiry enforced server-side
   - Expired tokens rejected with clear error
   - Rate limiting on resend endpoint (3/hour)
   - Token not leaked in any API response (only sent via email)

2. B3 - Registration flow:
   - New members get emailVerified=false
   - Unverified members cannot log in (auth callback rejects them)
   - Login page shows "verify email" message with resend button for unverified users
   - Verification link works end-to-end (token -> verify -> emailVerified=true)

3. B3 - Booking gate:
   - POST /api/bookings checks emailVerified before processing
   - Returns 403 for unverified members
   - Existing booking flows unaffected for verified members

4. B3 - Grandfathering:
   - Schema has @default(false) on emailVerified
   - Migration note/comment exists for bulk-updating existing members

5. B2 - Email change tokens:
   - Tokens cryptographically random, single-use, 1h expiry
   - New email validated: format, not same as current, not taken
   - Verification sent to NEW email, notification sent to OLD email
   - Token not leaked in API responses

6. B2 - Email change confirmation:
   - Member email updated atomically
   - Xero contact updated if connected (fire-and-forget, logged on error)
   - Audit log entries for request and confirmation
   - Rate limiting on request endpoint (3/hour)

7. Security checks:
   - No SQL injection in token lookups (Prisma parameterised)
   - No timing attacks on token comparison (Prisma WHERE is fine)
   - Email templates escape user-provided values (use escapeHtml)
   - CSRF: all mutation endpoints are POST (not GET)
   - Resend/request endpoints require authentication

Run `npm test` and `npm run build` -- both must pass.
Fix any issues found. Do NOT add features or refactor beyond what's needed.
Commit fixes and push.
```

---

### 5c. Merge Prompt

```
Merge the Phase 5 feature branch into main.

Steps:
1. Ensure all tests pass on the feature branch: `npm test && npm run build`
2. Switch to main: `git checkout main && git pull origin main`
3. Merge: `git merge <feature-branch> --no-ff -m "Merge Phase 5: Member Auth Enhancements"
4. Run tests again on main: `npm test && npm run build`
5. Push main: `git push origin main`
6. If merge conflicts occur, resolve them preserving Phase 5 changes and existing main functionality. Run tests after resolution.
```
