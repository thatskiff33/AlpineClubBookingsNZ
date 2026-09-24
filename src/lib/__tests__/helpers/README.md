# Typed test helpers

Reusable helpers for tests in this repo. Use them to keep test types
honest without sprinkling `as any` over mock returns and session
literals.

## Where these live

Under `src/lib/__tests__/helpers/`. They are imported only from test
files — never from production code — and tsconfig excludes `__tests__`
folders from production builds.

## Sessions

```ts
import { adminSession, memberSession } from "@/lib/__tests__/helpers";

vi.mocked(auth).mockResolvedValue(adminSession());
vi.mocked(auth).mockResolvedValue(adminSession({ id: "admin-9" }));
vi.mocked(auth).mockResolvedValue(memberSession({ role: "MEMBER" }));
```

Helpers return `Session` typed values, so `auth()` mocks no longer need
`as any`.

## Route handlers

```ts
import { jsonRequest, nextRequest, routeParams } from "@/lib/__tests__/helpers";

const res = await POST(
  jsonRequest("/api/admin/members/m-1/lifecycle/archive", { reason: "test" }),
  routeParams({ id: "m-1" }),
);
```

`nextRequest()` prepends a localhost origin so callers can pass a path
or a full URL. `routeParams()` wraps a plain object in the
`Promise<...>` shape Next.js 15 hands to route handlers.

## Domain factories

```ts
import {
  bookingFactory,
  memberFactory,
  paymentFactory,
} from "@/lib/__tests__/helpers";

const member = memberFactory({ id: "m-9", email: "m9@example.org" });
const booking = bookingFactory({ memberId: member.id, status: "CONFIRMED" });
const payment = paymentFactory({ bookingId: booking.id, status: "PAID" });
```

Each factory returns a fully populated record typed against the Prisma
model. Pass a partial override to change only the fields a test cares
about.

Other factories:

- `adminMemberFactory`
- `familyGroupFactory`
- `bookingGuestFactory`
- `paymentRefundFactory`
- `memberCreditFactory`
- `xeroContactFixture`

## Prisma delegate mocks

```ts
import { mockDelegate, READ_METHODS } from "@/lib/__tests__/helpers";

const memberDelegate = mockDelegate(READ_METHODS);
memberDelegate.findUnique.mockResolvedValue(memberFactory());
```

Use `READ_METHODS`, `WRITE_METHODS`, or `FULL_DELEGATE_METHODS` to seed
common method sets. Each method is a `vi.fn()` typed as `Mock`, so
`mockResolvedValue` and friends work without casts.

`transactionShim(client)` returns a `$transaction` shim that hands the
same client to the callback, useful when a service is implemented as
`prisma.$transaction((tx) => ...)`.

### Honouring the query's `select` in a guard test

```ts
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return { prisma: { member: { findUnique: honourSelect(mockFindUnique) } } };
});

mockFindUnique.mockResolvedValue({ active: true, canLogin: false, accessRoles: [...] });
```

`honourSelect(mock)` shapes every resolved fixture by the caller's arguments,
so the code under test sees only the fields its query asked for. Use it in any
test of a gate that re-reads a member. A fixture that carries a field the query
never selected otherwise proves nothing: `requireAdmin` passed its suites for
years without selecting `canLogin`, because every fixture carried it (#3603).
`projectSelect(row, select)` and `projectInclude(row, include)` are the same
projections for a one-off.

What it models, and where it stops short of the real client:

- a scalar selected `true` passes through; a relation with a nested `select` is
  projected through it;
- a relation selected `true`, or with only `where`/`orderBy`/`take`, keeps its
  scalar fields only, and one with `include` keeps its scalars plus the included
  relations; a query with neither `select` nor `include` gets the row's scalars;
- a field the query selects but the fixture lacks stays absent — the helper
  never invents a value;
- it cannot tell a relation from a `Json` column holding an object, so a Json
  object selected `true` keeps only its top-level scalar members;
- `where`, `orderBy` and `take` are not applied: the mock still decides which
  row comes back.

## Recovery-alert focus (jsdom only)

```ts
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
await expectRecoveryAlertToHoldFocus(alert);
```

The one correct way to assert that a permanently mounted recovery alert holds
focus. Written by hand the assertion races React's effect flush, which is what
reddened `main` in #2635 — see [`../../../../docs/TESTING.md`](../../../../docs/TESTING.md)
for the measurement and for the two spellings to avoid.

Imported from its own module rather than the barrel above, like `clock.ts`: it
pulls in `@testing-library/react`, which has no business being loaded by the
node-environment suites that use the barrel for factories and Prisma mocks.

## Settling a lodge-scoped page before interacting (jsdom only)

```ts
import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

render(<HutLeadersPage />);
await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
fireEvent.click(screen.getByRole("button", { name: /pick range/i }));
```

For any suite that drives a **mocked** child of a lodge-scoped admin page — the
`OccupancyCalendar` on `/admin/hut-leaders` and `/admin/roster`, and since #2953
`LodgeSelect` on `/admin/bed-allocation`. The mock's button is in the DOM on the commit that first renders
the lodge-scoped form, so `fireEvent` can dispatch before that commit's passive
effects run — and one of them resets the picked range. The picked dates are then
wiped, failing a synchronous assertion, or removing step 2 of the assignment form
and failing as `Unable to find role="button" and name "Any member"`. That is an
ordering bug: it reproduces with the RTL async window at 4,000ms, so no wider
window fixes it (#2944, mechanism and measurements in the module comment; see
also [`../../../../docs/TESTING.md`](../../../../docs/TESTING.md)).

Import it directly rather than through the barrel, like `focus.ts` — it pulls in
`@testing-library/react`.

## Club time zone premise

```ts
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

beforeEach(() => {
  expectClubTimeZonePremise();
  vi.setSystemTime(instantWhoseUtcDayIsYesterday);
});
```

For a suite whose subject is "the club's calendar day is not the UTC day".
`APP_TIME_ZONE` follows `process.env.TZ`, so a runner with `TZ=UTC` moves the
club's zone too and every date assertion in such a suite goes red reading like
the product bug it proves fixed. Call it from the `beforeEach` that pins the
divergent instant, so the environment failure arrives before any date assertion.
See [`../../../../docs/TESTING.md`](../../../../docs/TESTING.md) rules 3 and 6.
Import it directly rather than through the barrel, like `clock.ts`.

## Diagnostics statement column reads

```ts
import {
  collectStatementColumnReads,
  statementColumnReads,
} from "@/lib/__tests__/helpers/diagnostics-statement-reads";
```

Resolves every `alias."column"` reference in an AI Diagnostics `select_only_sql`
statement to a `Relation.column` pair, with `alias -> relation` bound **per
statement** (the same short alias means a different relation in different
statements).

It exists so the two suites that reconcile the SELECT-only grant allowlist against
the statements answer the *same* question:
`src/lib/diagnostics/tools/__tests__/provision-role.test.ts` compares the reads
against the declaration on every pull request, and
`src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts` compares them
against what PostgreSQL will actually hand the provisioned role. Two copies of the
parser would let those halves drift apart while both stayed green. Import it
directly rather than through the barrel, like `clock.ts`.

## Shelling out to a bash gate script

```ts
import {
  bashFixturePath,
  bashGateArgs,
} from "@/lib/__tests__/helpers/bash-fixture-path";

const result = spawnSync(
  "bash",
  bashGateArgs("scripts/validate-blue-green-migrations.sh", [bashFixturePath(migrationPath)], {
    MIGRATION_SAFETY_LEDGER: bashFixturePath(ledgerPath),
  }),
  { cwd: process.cwd(), env: process.env, encoding: "utf8" },
);
```

**Use these for every new shell-out.** On Windows `bash` is
`C:\Windows\System32\bash.exe` — WSL, not Git Bash — and it can read neither a
drive-letter path nor a variable set on `spawnSync`'s `env`. Writing the
invocation the obvious way therefore fails two ways: loudly (`Migration SQL file
not found: C:/Users/…`) and, worse, silently, with the gate falling back to its
production defaults and validating the repository's real files instead of the
fixture (#2886).

`bashFixturePath` returns a path relative to the spawn's `cwd`, which resolves
under WSL and Git Bash alike. If the repository and fixture are on different
Windows volumes, it asks the selected shell's `wslpath` or `cygpath` for the
absolute POSIX form and fails before invoking the gate if neither can translate
it. `bashGateArgs` inlines variables into the `-c` string, which is the only form
that crosses into WSL. These are no-ops or equivalents on Linux and CI. The
module comment carries the measurements and the equivalence check. Import it
directly rather than through the barrel, like `clock.ts`.

Run a POSIX tool through `bashToolArgs`. Windows ships no native `awk.exe`, but
the stock WSL bash provides `/usr/bin/awk`; the splitter-equivalence contract
therefore runs on Windows rather than being capability-skipped. The helper
quotes every argument into one `bash -c` command, so spaces and apostrophes do
not become a reason to fall back to direct spawning.

## Conventions

- Helpers must not import anything from `src/app/...` so they stay
  test-only and free of production side effects.
- Add a new factory here when more than one test starts to repeat the
  same literal record shape.
- Prefer extending an existing factory's override shape over duplicating
  helpers per file.
