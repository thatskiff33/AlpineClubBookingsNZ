# Project Goals

Audience: Developer, Agent, Adopter

This page is the full context behind the project's three current goals. The
short goal statements kept elsewhere point here; this is where the method,
scope, release flow and pilot test are written down so contributors and agents
can read the "why" behind sweep, release and pilot work.

## Shared aim

Other lodge-owning clubs run AlpineClubBookingsNZ themselves, installing it
from tested releases. The maintainer's own club is the reference club, and the
maintainer is not a bottleneck: a club can get live and keep running without
waiting on one person.

The main blocker to adoption today is that **getting live the first time is
too hard**. Each goal below removes part of that blocker.

## Order, and its risk

The goals run in order: **Goal 1 → Goal 2 → Goal 3**. Robustness comes first so
that the release clubs install is worth installing; a tested release comes
next so the pilot club has something stable to install from.

The risk: Goal 1's finish line is "zero open issues", and each sweep repeats
"until clean". Anything filed along the way counts, so the finish line can keep
moving — and Goals 2 and 3 wait on it. Watch for this; if Goal 1 keeps
growing instead of shrinking, that is a signal to revisit scope, not to keep
sweeping silently.

## Goal 1: Robustness

**Done when:** there are zero open issues, full stop — including anything
filed along the way.

### First move: find where bugs come back

Before sweeping, rank the business areas by bugs that came back — fixed, then
re-broken or re-fixed (ALP-4). The review proposes the list of areas, the
maintainer confirms it, and each area shows its evidence (the issues and fixes
that make it "hot"). Every sweep below then starts with the hottest areas.

### The seven sweeps

Each sweep is repeated until a fresh pass finds nothing.

1. **Single source of truth.** Each fact is defined in one place. A second
   wording is fine; a second definition isn't.
2. **Security**, explicitly including personal and card data never reaching
   logs.
3. **Payment flows.**
4. **Accuracy.**
5. **Member screens are intuitive.**
6. **Admins and booking officers easily know where to go** to fix issues and
   change settings.
7. **Structure.** Oversized files are split so each does one job, starting
   with cancellation and bed allocation.

For sweeps 5 and 6, "clean" means reviewer judgement against good usability
practice — there is no mechanical check for "intuitive".

### Docs that go with it

- **Agent docs slimmed.** [`AGENTS.md`](../AGENTS.md) and `CLAUDE.md` are cut
  down to the architecture and the key rules, so agents stop guessing.
- **Adopter guides kept accurate** for the pilot (Goal 3). The
  [adopter path](adopters/README.md) is what the pilot volunteer will follow,
  so a sweep that changes behaviour updates it in the same change.

### Method

Sweeps use the 8 August 2026 audit format
([#2680](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2680),
[#2725](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2725)).
Each finding becomes an issue with these sections:

1. Plain-English problem.
2. Exact locations.
3. Root cause and lesson.
4. Scope.
5. Testable acceptance criteria.
6. Risk and review perspectives.
7. Watchpoints.
8. Options, with one marked **Recommended**.

Then:

- The maintainer walks through the decisions. Nothing starts until the issue
  is marked "ready to action".
- Before building, re-check the locations against the current code — they may
  have moved since the issue was written.
- Run challenge-style reviews (reviewers trying to break the change) before
  merge.

Two further shapes feed the method:

- **The single-source-of-truth questions** from
  [#3126](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3126):
  *make the mistake impossible before you police it.* Prefer a design where the
  wrong thing cannot be written over a check that catches it afterwards.
- **The late-September money-sweep shape:** narrow the scope → name the defect
  type → double-check → file. A sweep that knows exactly which kind of defect
  it is looking for, in a bounded area, finds real problems and files fewer
  false ones.

### Gut-check: the "headache level"

Alongside the issue count, ask three questions:

- Are changes easy to make without breaking things?
- Are problems staying fixed?
- Are we confident the agent understands a change's impact?

If the answers are trending towards "yes", Goal 1 is working even while the
count moves.

### Out of scope

- Reorganising `src/lib` by business area.

## Goal 2: Tested releases

The flow:

1. **Public `main`** — the development branch, where changes land.
2. **The maintainer's staging**, running on a copy of live data.
3. **A tagged release** that clubs install and upgrade from.

`main` stays the development branch, and clubs don't install from it.

**Done when:** a new tested release is published and the
[adopter guide](adopters/README.md) points to it. The last release was
v0.13.2, on 23 July 2026 (see [`releases/README.md`](releases/README.md) and
[`UPGRADING.md`](UPGRADING.md)).

### Out of scope

- Making upgrades and ongoing maintenance easier. That matters, but it comes
  after a club is live.

## Goal 3: Pilot club live

**Who:** one real club — possibly one of the existing test forks — with a
tech-comfortable volunteer. They can follow step-by-step server instructions,
but they are not a developer.

**Done when:** that volunteer installs from the latest tested release and the
club takes real bookings with real money — Stripe, Xero and email all
connected — using the docs and the app, without needing the maintainer. Help
from contributors helping clubs set up is fine; the test is that the
maintainer is not the bottleneck.

Whatever the pilot trips over becomes the next to-do list.

### Out of scope

- Hosting clubs' sites for them.
- A no-command-line setup for non-technical people.
