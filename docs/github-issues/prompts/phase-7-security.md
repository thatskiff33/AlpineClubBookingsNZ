# Phase 7: Security Hardening

You are fixing 6 security hardening issues. Make each change exactly as described.

## Setup

```
git checkout -b fix/phase-7-security-hardening
```

## Change 1 of 6: Add Sentry edge config beforeSend hook

Read `sentry.server.config.ts` to see the existing `beforeSend` hook pattern. It should scrub sensitive fields from error events.

Now read `sentry.edge.config.ts`. It will be minimal — just a `Sentry.init()` call. Add the same `beforeSend` hook. The edge config should look like:

```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  beforeSend(event) {
    // Scrub sensitive data from error events
    if (event.request?.data) {
      const data = event.request.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (/password|token|secret|authorization|cookie/i.test(key)) {
          data[key] = "[REDACTED]";
        }
      }
    }
    if (event.request?.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const key of Object.keys(headers)) {
        if (/authorization|cookie|token/i.test(key)) {
          headers[key] = "[REDACTED]";
        }
      }
    }
    return event;
  },
});
```

Copy the EXACT `beforeSend` logic from `sentry.server.config.ts` — don't guess. Read it first and replicate it exactly.

## Change 2 of 6: Add active-member check to booking creation

Read `src/app/api/bookings/route.ts`. Find the POST handler. After the auth/session check (where `session.user.id` is available), add:

```typescript
  // Verify member is still active (session JWT may outlive deactivation)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { active: true },
  });
  if (!member?.active) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }
```

Place this BEFORE the subscription check and booking logic, but AFTER the auth check. Read the existing code to find the right insertion point.

Now do the same for `src/app/api/payments/create-payment-intent/route.ts`. Read it, find the auth check, and add the same active-member validation right after.

## Change 3 of 6: Align token expiry times and document

Read `src/lib/verification-tokens.ts`. Find the expiry constants. They should be:
- Email verification: 24 hours
- Email change: 1 hour

Change email verification to 48 hours and email change to 2 hours:

```typescript
// Token expiry strategy:
// - Email verification: 48h (generous — users may not check email same day)
// - Email change: 2h (moderate — user initiated, but allow for email delay)
// - Password reset: 2h (set in forgot-password route, not here)
// - Admin invite: 7 days (set in admin members route, new users may be slow)
const EMAIL_VERIFICATION_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours
```

Find the line that sets the verification token expiry (something like `new Date(Date.now() + 24 * 60 * 60 * 1000)`) and change `24` to `48`. Use the constant if one exists, or create one.

For email change tokens, find where the 1-hour expiry is set and change to 2 hours.

Now read `src/app/api/auth/forgot-password/route.ts` (or wherever password reset tokens are created). Find the expiry and change from 1 hour to 2 hours. Add a comment:

```typescript
    // Password reset: 2h expiry (allows time for email delivery delays)
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
```

## Change 4 of 6: Prevent email inheritance from dependents

Read `src/app/api/admin/members/[id]/route.ts` and find the PUT handler. Search for `inheritEmailFromId` validation (around lines 232-246). You should see checks for self-loop and active adult. Add one more check:

After the existing validation (where the source member is fetched), add:

```typescript
    // Source must be a primary member (not a dependent)
    if (source.parentMemberId !== null) {
      return NextResponse.json(
        { error: "Email can only be inherited from primary members, not dependents" },
        { status: 400 }
      );
    }
```

Make sure the `source` query includes `parentMemberId` in the select. Read the existing query to check.

## Change 5 of 6: Increase HSTS max-age

Read `Caddyfile`. Find the HSTS header line:

```
Strict-Transport-Security "max-age=31536000; includeSubDomains"
```

Change to:

```
Strict-Transport-Security "max-age=63072000; includeSubDomains"
```

## Change 6 of 6: Harden Docker container

Read `docker-compose.yml`. Find the `app` service. Add these security options under the service (at the same indentation level as `image`, `ports`, etc.):

```yaml
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
```

Also, check if the Next.js app writes to any directory at runtime (like `.next/cache`). If so, you may need to add that as a tmpfs or volume too. Read the Dockerfile to check if the `.next` directory needs to be writable. If it does:

```yaml
    tmpfs:
      - /tmp
      - /app/.next/cache
```

## Verify

```bash
npm test
npm run build
docker compose build 2>&1 | tail -5
```

The docker build should succeed. If the read_only change causes runtime issues, you may need to adjust tmpfs mounts.

## Commit

```bash
git add -A
git commit -m "Security hardening: Sentry edge scrub, active check, token expiry, Docker

- M13: Add beforeSend scrubbing to Sentry edge config
- M14: Add active-member validation on booking creation + payment intent
- H6: Align token expiry (verification 48h, reset 2h, change 2h) with documentation
- M11: Prevent email inheritance from dependent members
- L8: Increase HSTS max-age to 2 years
- L9: Docker container read-only with tmpfs and no-new-privileges"
```
