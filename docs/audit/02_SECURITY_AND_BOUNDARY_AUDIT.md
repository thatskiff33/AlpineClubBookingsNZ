# Phase 2: Security And Boundary Audit

## Goal

Prove that the app's trust boundaries are correct before any go-live decision.

## Scope

- Authentication and session handling
- Authorization and active-user enforcement
- Public vs authenticated vs admin vs lodge/kiosk boundaries
- API input validation and response exposure
- Rate limiting, webhook verification, cron auth, health endpoints
- Security headers, CSP, CORS, and middleware behavior

## Steps

1. Build the route and boundary matrix.
   - Group routes by public, member, admin, webhook, cron, and health surfaces.
   - Confirm which layer enforces access: layout, route guard, helper, middleware, or none.
2. Audit auth and authorization.
   - Check `auth()` usage, active-member checks, role checks, and privilege boundaries.
   - Confirm deactivated users cannot retain useful access.
3. Audit validation and error behavior.
   - Check request parsing and Zod coverage for body, query, and route params.
   - Check for inconsistent error shapes or status codes that hide failures.
4. Audit exposure and security controls.
   - Check responses for sensitive field leaks.
   - Check headers, CSP allowances, CORS behavior, and any permissive defaults.
5. Audit webhooks, cron, and operational endpoints.
   - Verify signature checks, timing-safe compares, replay/idempotency behavior, and secret handling.

## Suggested Lanes

- Lane A: admin and member API routes
- Lane B: public routes, auth flows, lodge/kiosk flows, layouts
- Lane C: webhooks, cron, health endpoints, middleware, rate limiting

## Required Outputs

- Trust-boundary findings by severity
- Route matrix showing where access is enforced
- List of routes missing validation, rate limiting, or consistent error handling
- Confirmed auth and admin blockers, if any

## Exit Criteria

- Every non-public route is accounted for
- Every privileged route has explicit enforcement identified
- Sensitive operational endpoints are verified or flagged
- No unresolved auth-bypass or exposure issue remains unclassified

## Validation Expectations

- Add targeted tests immediately for any auth or route-guard fix
- Re-run at least the touched route tests plus `npm run lint`
