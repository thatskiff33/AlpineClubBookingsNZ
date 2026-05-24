# Security Notes

This document captures security decisions and trade-offs that are too
implementation-specific for `SECURITY.md` at the repository root. The
root `SECURITY.md` covers the public reporting policy; this file
captures internal mitigations and operator-facing rationale.

## Membership cancellation confirmation tokens in URL paths

### Context

Members included in a membership cancellation request receive an email
with a confirmation link. The link carries a 256-bit token in the URL
path:

```
https://<host>/membership-cancellation/<token>
```

URL paths are routinely captured by:

- Next.js / Node access logs
- Reverse-proxy logs (Caddy, in our deployment topology)
- Sentry and any other observability tooling that captures request
  metadata
- Browser history
- The `Referer` header of any outbound link click from the confirmation
  page

### Residual risk

The consume route requires both the token *and* an authenticated
session whose `member.id` matches the participant who received the
link. A stolen token alone cannot be replayed without first
compromising that exact member's session. The residual risk is
restricted to scenarios where an internal actor with log access could
see the token plus separately compromise the same member.

### Mitigation

The shared text redaction layer (`src/lib/redact-sensitive-json.ts`)
strips the token segment from any string that contains
`/membership-cancellation/<token>` before the value is emitted by the
Pino logger or attached to an `err` payload. The replacement is
`/membership-cancellation/[REDACTED]`. This covers structured request
logs, captured error stacks, and any other observability surface that
flows through `redactSensitiveText`.

The token remains in clear text in the email body sent to the
participant, which is the only place the participant needs it.

### Operator checklist

When reviewing observability dashboards or proxy access logs that are
exported outside of the application process, confirm that the source
also redacts paths matching `/membership-cancellation/[^/]+`. The
application-level redaction does not protect logs that the application
does not emit.
