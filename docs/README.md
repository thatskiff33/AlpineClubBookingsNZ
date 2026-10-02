# Documentation

AlpineClubBookingsNZ is a generic booking, membership, payment and
lodge-operations platform for small clubs. **One deployment serves one club**,
and the repository itself does not encode which club — everything that differs
between clubs is configuration.

The documentation is split by audience. Pick the door you need; each one is a
complete path you can read end to end without wading through the others.

| You are… | Go to |
| --- | --- |
| **Adopting, configuring, deploying or operating** the platform for a club | **[Run this for your club](adopters/README.md)** |
| **Changing the code** — a contributor, or an automated agent | **[Change the code](contributors/README.md)** |
| **Using** a club that already runs it — a member or a guest | **[Member & Guest Guide](user-guide/README.md)** |

## The short version of each door

**[Run this for your club](adopters/README.md)** — what the product is, how to
configure it for your club, how to deploy it, and the illustrated operator
guide for every admin area. Its most-used pages:
[Configure, don't fork](adopters/configure-or-fork.md) ·
[`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) ·
[`../CONFIGURATION.md`](../CONFIGURATION.md) ·
[`../DEPLOYMENT.md`](../DEPLOYMENT.md) ·
[operator guides](adopters/README.md#operating-a-live-club) ·
[`UPGRADING.md`](UPGRADING.md) ·
[Contribute a change upstream](adopters/upstream-contributions.md).

**[Change the code](contributors/README.md)** — the agent contract, the
architecture, the domain invariants, the state machines, the testing and
security contracts, and the feature hubs. Its most-used pages:
[`../AGENTS.md`](../AGENTS.md) ·
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) ·
[`DOMAIN_INVARIANTS.md`](DOMAIN_INVARIANTS.md) ·
[`STATE_MACHINES.md`](STATE_MACHINES.md) ·
[`TESTING.md`](TESTING.md) ·
[`STYLE_GUIDE.md`](STYLE_GUIDE.md).

**[Member & Guest Guide](user-guide/README.md)** — plain-English guides for the
people who use the club: booking a stay, paying, the waitlist, your family, your
account. Also mirrored to the
[project wiki](https://github.com/thatskiff33/AlpineClubBookingsNZ/wiki).

## How this is organised

Every live page under `docs/` has **one canonical home** on one of those three
paths, and the other paths link to it rather than keeping a second copy of the
same guidance. A page that genuinely serves two audiences still belongs to one
of them; the CI index check
(`pnpm run docs:indexcheck`) fails if any page becomes unreachable.

New to writing here? [`STYLE_GUIDE.md`](STYLE_GUIDE.md) defines the audience
labels, the pinned locations for operator and member guides, and the page
skeletons. [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) maps every admin route
area to its documentation or its gap.

## Release notes

Per-release notes and the owner-review communication drafts are indexed in
[`releases/README.md`](releases/README.md), newest first.
[`../CHANGELOG.md`](../CHANGELOG.md) is the full change history, and
[`UPGRADING.md`](UPGRADING.md) carries the release-by-release upgrade steps.

