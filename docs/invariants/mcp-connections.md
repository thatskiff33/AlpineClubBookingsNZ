# AI App Connections

Audience: Developer, Agent.

Prefix defined in this file: **`INV-MCP`** — how a member connects an AI app
(an MCP client such as Claude or ChatGPT) to their own account on the club's
site, who may hold such a connection, how the app obtains and keeps it, how it
ends, and how each action it runs reaches the site.

Read this file when you are changing anything under
[`src/lib/mcp/`](../../src/lib/mcp/), the routes under `src/app/api/mcp/`,
`src/app/api/member/mcp-grants/`, `src/app/api/admin/mcp/` or
`src/app/.well-known/`, the approval screen at `/connect/authorize`, the
`McpClient`, `McpGrant`, `McpAuthCode`, `McpToken` or `McpSettings` models,
the internal principal-header branch of `auth()`, or
[`session-refresh.ts`](../../src/lib/session-refresh.ts). Adding, moving or
removing any API route method also lands here, because every one must be
classified (`INV-MCP-006`).

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

How the feature works, the action list and the stated limits are in the
[AI app connections guide](../guides/mcp-server.md); the lifecycle is in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#ai-app-connection-lifecycle); the
route families are in
[`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md). This file holds
only the rules.

## INV-MCP-001

- **The `mcpServer` module is the only switch, and it defaults to off.** A club
  has to choose to let members' data leave for an AI provider, so an upgrade
  never turns it on (`INV-CONFIG-001`).
- **While it is off, every AI-connection door answers 404.** The `mcpServer`
  rule in [`feature-routes.ts`](../../src/config/feature-routes.ts) covers
  `/connect`, `/api/mcp`, `/api/member/mcp-grants`, `/api/admin/mcp` and both
  `/.well-known/oauth-*` documents, and every one of those route handlers and
  the approval page re-checks `loadEffectiveModuleFlags()` itself
  (`mcpModuleOffResponse`), so the gate never lives only in the proxy (#2780).
  The admin page is gated by its hub registry entry's `mcpServer` flag and the
  profile card is not rendered.
- **The member reads added for the actions are absent too.**
  `GET /api/bookings/mine`, `GET /api/bookings/[id]`, `GET /api/profile/summary`,
  `GET /api/notices`, `GET /api/notices/[id]`, `GET /api/lodge-roster` and
  `GET /api/work-parties` sit beside older routes, so no proxy prefix can cover
  them: each handler's own `mcpModuleOffResponse` check is the gate.
- **Existing connections cannot be used while it is off**, because `/api/mcp`
  and the token endpoint answer 404 before reading a token. They are kept, not
  ended, and work again when the module is switched back on, subject to every
  other rule here.

## INV-MCP-002

- **Who may hold a connection is the club's policy, `McpSettings`, asked at
  approval and again on every use.** `mcpConnectionRefusal` refuses a kiosk
  account, an unverified email, and anyone `mayHoldMcpConnection` rejects: an
  officer (anyone `hasAdminPortalAccess` admits) is judged by
  `officersMayConnect` alone, everyone else by `membersMayConnect`. The
  approval page and its `POST /api/member/mcp-grants` both run it through
  `resolveMcpApproval`; every `/api/mcp` request and every token issue run it
  through `resolveMcpGrantUse`, so switching a group off stops their existing
  connections on the next request. A forced password change and an unmet
  two-factor requirement are refused by the signed-in layout at approval and
  by `requireActiveSessionUser` on use, never by a second copy here.
- **A connection may do the lesser of what the member approved and
  `maxScope` now** (`effectiveMcpScope`); lowering `maxScope` narrows every
  connection without rewriting one.
- **The defaults are members on, officers off, view only, and three approved
  hosts.** A missing row reads as `DEFAULT_MCP_SETTINGS`, which equal the
  column defaults.
- **Connections are managed only on the website.** Approving, listing and
  ending connections, and reading or saving the policy, refuse any request
  carrying the internal principal header (`mcpConnectionMayNotManage`, 403),
  and their routes are permanent `auth-flow` exclusions (`INV-MCP-006`). Saving
  the policy needs `support` edit and is a fresh-proof route (`INV-AUTH-010`).

## INV-MCP-003

- **An app obtains a connection only by the authorisation-code flow with PKCE
  S256**, as a public client that registered itself; no implicit, password or
  client-secret grant exists. The challenge is checked when the member
  approves, the verifier when the code is exchanged.
- **The approval is delivered only to an approved host or to loopback.**
  `checkMcpRedirectUri` accepts `https` on a host in `allowedRedirectHosts`,
  matched exactly, or `http` on `127.0.0.1`, `localhost` or `[::1]`. It runs at
  registration, at approval and on every use and renewal against the list as
  it is then (`resolveMcpGrantUse` reads the approval code's address, kept
  until the connection ends). A removed host refuses its connections without
  ending them. The requested address must be one the app registered, a
  loopback port excepted.
- **A code lasts five minutes and is single use.** Presenting a used code, or
  losing the claim on it, ends the connection (`code-reuse`).
- **Codes and tokens are stored only as SHA-256 hashes**
  ([`TOKEN_HASHING.md`](../TOKEN_HASHING.md)), and every token is bound to this
  site's `/api/mcp` (`resource`).
- **An access token lasts one hour. A refresh token is single use and
  rotates**: presenting a used one ends the connection (`refresh-reuse`). Its
  30-day lifetime is a ceiling only; the connection ends sooner with the
  sign-in behind it (`INV-MCP-005`).
- **Whether tokens may be issued is asked before the code or refresh token is
  spent**, so a refusal the club can undo does not burn the app's credential.

## INV-MCP-004

- **A connection (`McpGrant`) is ACTIVE from approval and ends once, as
  REVOKED or EXPIRED.** Neither end state returns to ACTIVE; reconnecting
  creates a new connection.
- **Every end goes through `endMcpGrants`**, a status-guarded `updateMany`
  on `status: "ACTIVE"`. The first writer wins; a later one changes nothing and
  returns zero, which the member and officer disconnect routes answer as 404.
  The connection's tokens and codes are deleted in the same step whoever won,
  so nothing that could be presented outlives it.
- **Every end records one reason from `MCP_GRANT_END_REASONS`**, and the reason
  alone decides the status: `member-revoked`, `admin-revoked`, `app-revoked`,
  `replaced`, `refresh-reuse` and `code-reuse` give REVOKED; `session-ended`
  and `never-completed` give EXPIRED. A new end path adds its reason there and
  in [`STATE_MACHINES.md`](../STATE_MACHINES.md#ai-app-connection-lifecycle).
- **A connection is listed only once the app has collected its approval**
  (ACTIVE with at least one token).

## INV-MCP-005

- **A connection signs in through `auth()` as the member, not as a second kind
  of account.** `/api/mcp` calls the site with the internal principal header
  `x-mcp-principal`: an HMAC-SHA-256 value under a key derived from the auth
  secret with its own label, naming the connection, valid for 30 seconds and
  only while the call it was issued for is in flight in the issuing process
  (`issueMcpPrincipal`), so a copied value cannot be replayed.
  `auth()` checks it first; a value that does not verify, or names a
  connection that is not ACTIVE, reads as signed out and never falls back to a
  cookie.
- **The session is built from the connection by the browser's own code.**
  `buildMcpGrantSession` passes the approving sign-in's `sessionIssuedAt` and
  two-factor result through `refreshSessionToken` and
  `applySessionTokenToUser` in
  [`session-refresh.ts`](../../src/lib/session-refresh.ts), so a disabled
  login, a newer password, the maximum session age (`INV-AUTH-007`), role
  changes and the two-factor rules reach a connection by the same code. A
  connection whose sign-in has ended is ended `session-ended`.
- **`lastAuthenticatedAt` is never set on a connection's session.** Whenever
  `requireRecentAuth` reads the session (`INV-AUTH-008`), it refuses a
  connection. Fresh-proof routes are also permanent exclusions
  (`INV-MCP-006`), so a connection cannot reach one while the officer sign-in
  switch is off either.

## INV-MCP-006

- **Every method of every route under `src/app/api` is a catalogue
  action or has a stated exclusion reason.** `classifyMcpRoute` in
  [`exclusions.ts`](../../src/lib/mcp/exclusions.ts) answers for each;
  [`mcp-route-census.test.ts`](../../src/lib/__tests__/mcp-route-census.test.ts)
  fails on anything unclassified, a catalogue entry whose route method is
  missing, and an action on a permanently excluded route.
- **A permanent reason says a route is never an action.** Each is a key of
  `MCP_PERMANENT_EXCLUSION_REASONS`. `fresh-proof` is read from
  `STEP_UP_ROUTES`, never copied. A member or officer route's reason names
  its exact method and path. A permanent exclusion beats a catalogue entry.
- **A `not-yet:` reason names the officer stage** from `MCP_NOT_YET_TASKS`;
  that stage's change adds its entries and removes its rule. No member route
  has one. A route in an undecided or finished area stays unclassified,
  failing the census.
- **The catalogue adds no behaviour or permission.** An action's request
  schemas and `returns` shape are its route's, imported from lib modules
  ([`connection-shapes.ts`](../../src/lib/connection-shapes.ts) for shapes,
  `INV-SSOT-001`).
- **A connection is sent only what its action returns.** A route the website
  also reads answers a request carrying the principal header through
  `connectionJson` or `projectForConnection`, keeping only the shape's fields
  at every depth; a refusal passes unchanged. Only a `POST` the census pins
  as side-effect free may run as a `preview` read.
- **A member action acts as a member, never as an officer.** A route with an
  officer branch decides with `memberOnlySessionUser`: no officer role, only
  `USER`/`ORG` access roles, an empty permission matrix. Officer reach read
  from records survives that, so the route also refuses it
  (`arrivesAsMcpConnection`). An on-behalf target or officer override flag
  from a connection is refused. A reused member page keeps its audience
  (register row `ai-apps`): committee-role notices (`notices.ts`) and the
  person's own account history.

## INV-MCP-009

- **An officer action runs only on a route its admin area gates, and is
  offered only to someone holding what the route's guard demands.**
  `mcpActionAdminRequirement` in
  [`catalogue.ts`](../../src/lib/mcp/catalogue.ts) reads the requirement from
  the admin route map, or from the entry's `requires` where the handler's
  `requireAdmin` names its own permission; the census holds `requires` to
  that guard. The tool list, `find_actions`, `describe_action` and
  `run_action` all ask it.
- **The route runs with the officer's real permissions** and its own guard
  decides, as for the browser, and answers through the projection. A
  step-up route stays website-only (`fresh-proof`, `INV-MCP-006`).
- **An officer action needs the officer's own approval for officer actions**
  (owner decision, #5305). `McpGrant.officerConsentAt` is set only when
  someone holding an admin area approves on the screen that says the app can
  also act as an officer. Without it, `mcpCallerMayUse` hides every officer
  action and `describe_action` and `run_action` tell the app the officer must
  reconnect; member actions keep working. Earlier approvals, and those given
  before the member became an officer, carry no date. The screen's wording is
  general, so one date covers every admin area, later ones included; no
  wording version is stored.
- **Every club-wide configuration change is `destructive`**, so the app asks
  the officer first.

## INV-MCP-007

- **An action reaches its route only through the site's front door.**
  `runMcpAction` sends an HTTP request to `127.0.0.1:$PORT` with the public
  `Host`, the caller's address and the principal header, and never imports a
  route handler, so the proxy's gates and the route's own guards run exactly
  as for a browser.
- **The dispatcher only ever refuses earlier, never permits more.** Before
  sending, it refuses a route with a permanent exclusion even if catalogued,
  refuses a `write` or `destructive` action on a connection whose effective
  scope is view only, and parses the arguments with the action's schema. It
  forwards what the app sent, not the parsed values, because the route is the
  authority on its input. Catalogue `fixedBody` fields are set last so the app
  cannot override them.
- **A view-only connection is not offered change actions as tools.**

## INV-MCP-008

- **Connection events a person causes, and every change action, write one
  audit row** through `recordMcpAudit` with category `security`: an approval
  (`MCP_CONNECTION_APPROVED`), a member's or an officer's disconnect
  (`MCP_CONNECTION_REVOKED`), a policy save (`MCP_SETTINGS_UPDATED`, written in
  the same transaction as the save), and every call of a `write` or
  `destructive` action, including one refused as view-only or one the site did
  not answer (`MCP_ACTION_CALLED`).
- **A row never carries an action's arguments or its result**
  (`INV-PRIV-011`); it names the action, the app, the member and the outcome.
  A member action's row names the member as its subject; an officer action's
  names none; the route writes its own audit rows, as for the admin screen.
- **Not audited, as built:** `read` action calls, and ends the system or the
  app causes (`app-revoked`, `replaced`, `refresh-reuse`, `code-reuse`,
  `session-ended`, `never-completed`), which are recorded only on the
  connection's `endedReason`.
