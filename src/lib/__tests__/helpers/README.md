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

## Conventions

- Helpers must not import anything from `src/app/...` so they stay
  test-only and free of production side effects.
- Add a new factory here when more than one test starts to repeat the
  same literal record shape.
- Prefer extending an existing factory's override shape over duplicating
  helpers per file.
