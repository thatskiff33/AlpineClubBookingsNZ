# Contribute a change upstream

Audience: Adopter, Developer

Every club that runs this platform ends up wanting something the product does
not do yet. This page is the route from "we built it in our fork" to "it ships
in the product", and the reason to take that route: **a change kept in your own
fork is a change you re-merge, re-test and re-debug on every future upgrade.**
The same change upstream is maintained, tested and released for you.

This page owns the *routing* decision and the fork/upstream git flow.
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) is the canonical contribution
process — local setup, the development rules, changelog fragments, validation
commands and what a pull request must contain. Read it before you open one; it
is not repeated here.

## Repository roles

- **The public upstream repository** holds the generic product: reusable
  features, bug fixes, framework upgrades, seed defaults, and adopter
  documentation. It must never encode which club a deployment serves.
- **Your deployment fork** (private, if you keep production configuration in
  git) holds your club's configuration, private branding, operational data
  fixes, and your production release coordination.

Public CI runs against the example club configuration, example branding, and
test or demo service credentials. Your fork's CI runs against your real
`config/club.json`, your assets, and your own secrets.

## Is this change reusable, or is it yours?

Apply the same test as [Configure, don't fork](configure-or-fork.md): *would a
different club answer this question differently?*

**Reusable — send it upstream:**

- a bug fix, anywhere;
- a new capability another club could plausibly want, behind a module toggle;
- a new setting, so the value each club differs on becomes configurable instead
  of hard-coded;
- a better seed default for a typical club;
- a framework, dependency or security upgrade;
- documentation that helps the next adopter.

**Yours — keep it in your fork or its environment:**

- your `config/club.json`, real branding assets, and logos;
- production identifiers, domains, and service credentials;
- one-off data fixes against your own database;
- deployment-only behaviour specific to your hosting.

Never port club-only values, production identifiers, private domains, member
data, or service secrets into the public upstream.

**Neither, quite?** If your club needs different *behaviour* rather than a
different *value*, the reusable version of your change is usually the setting,
not the behaviour. Contribute the configuration surface with a default that
preserves today's behaviour, then set your own value in your deployment. That
way the product gains a lever, and nobody else's upgrade changes underneath
them.

## Preparing a generic change

1. Branch from the public upstream `main` — not from your fork's `main`, which
   carries club-specific commits.
2. Strip out everything club-specific. If the change only makes sense with your
   club's data, it is not yet generic: add the configuration surface first.
3. Follow [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) for the development
   rules, validation commands, the changelog fragment, and the pull request
   contents.
4. Open the pull request against the public repository and wait for public CI
   to pass.
5. After it merges, fetch the public upstream into your deployment fork and
   merge it. **Preserve the upstream merge commit** — squash-merging a public
   sync makes future public-to-private drift much harder to reason about.
6. Run your fork's validation and deploy from your fork only.

## A change that only affects your club

1. Branch from your deployment fork.
2. Keep the change to private configuration, branding, operational copy, or
   deployment-only behaviour.
3. Review and merge it in your fork, then deploy from your fork.

If, later, you find yourself repeating the same club-specific change after every
upgrade, that is the signal to convert it into a setting and contribute the
setting upstream.

## A production hotfix

1. Branch from your deployment fork and apply the smallest fix that restores
   service.
2. Deploy from your fork once its validation passes.
3. If any part of the fix is generic, port that subset to the public upstream in
   a separate public pull request.
4. Pull the merged public change back into your fork, so both histories
   converge and the next upgrade does not conflict with your hotfix.

## Keeping the two in step

### Pull RELEASE TAGS, not `main`

**This is the one thing on this page most likely to cost you an outage, so it is
first.** `main` is a trunk: several lanes merge into it every day, and at any
moment it holds work that is finished but not released, and occasionally work
that is deliberately dormant until a later change switches it on. It is not a
release, and nothing promises that an arbitrary `main` commit is a coherent
product.

So a fork tracks **released tags**, one at a time —
[`../UPGRADING.md`](../UPGRADING.md)'s first principle, which also explains why
skipping a release skips its post-upgrade actions:

```bash
git fetch upstream --tags
git merge v0.13.2          # a tag, not upstream/main
```

Pulling `upstream/main` instead exposes you to every in-flight lane in the
repository. Two shapes are worth knowing about, because neither looks like a
problem at the moment you pull:

- **A dormant feature.** A change may deliberately ship inert, doing nothing
  until a later change consumes it. Pulled on its own it is harmless; pulled
  together with half of what consumes it, it is not.
- **A multi-part change.** Large work lands as an epic, and since #3002 an
  epic reaches `main` as a **single merge** from its own integration branch
  precisely so that a fork pulling `main` cannot catch it half-built. That
  protects you from epics. It does not protect you from anything else on the
  trunk — only pulling tags does that.

If you must track `main` — to test an unreleased fix, say — do it on a staging
deployment, never the one members use, and read
[`../../CHANGELOG.md`](../../CHANGELOG.md)'s `## Unreleased` section plus
[`../BLUE_GREEN_MIGRATION_SAFETY.tsv`](../BLUE_GREEN_MIGRATION_SAFETY.tsv) for
what you are taking on.

### Validation gates

Both repositories should run the same core validation gates:

```bash
npm audit --audit-level=high
npm run lint
npx prisma validate
npm test
npm run build
git diff --check
```

`npx prisma validate` and `npm run knip` both need `DATABASE_URL` set to some
value so `prisma.config.ts` resolves; an unreachable dummy is fine and is what
CI uses.

Confirm the whole loop once, with a dry run, before you rely on it:

1. Merge a trivial documentation change in the public upstream.
2. Pull the public upstream `main` into your fork.
3. Confirm your fork's CI runs with your configuration.
4. Deploy only during an approved deployment window.

## Related links

- Back to [Run this for your club](README.md).
- [Configure, don't fork](configure-or-fork.md) — which lever a change belongs
  on before it becomes code at all.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — the canonical contribution
  process.
- [`../UPGRADING.md`](../UPGRADING.md) — taking a new upstream release into your
  deployment.
- [`../../SECURITY.md`](../../SECURITY.md) — report a suspected vulnerability
  privately rather than in a pull request.
