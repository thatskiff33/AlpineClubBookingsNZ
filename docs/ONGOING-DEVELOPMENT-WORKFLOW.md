# Ongoing Development Workflow

AlpineClubBookingsNZ uses a public upstream repository for generic product work and a
private deployment fork for club-specific operations. Keep deploy-only
configuration, branding, service secrets, and club data in the private fork or
its deployment environment.

## Repository Roles

- `AlpineClubBookingsNZ` is the public upstream. Use it for generic product fixes,
  reusable feature work, framework upgrades, and adopter documentation.
- `AlpineClubBookingsNZ-private` is the private deployment fork. Use it for club-specific
  configuration, private branding, operational data fixes, and production
  release coordination.

## Generic Feature Or Fix

1. Branch from the public upstream `main`.
2. Open a public pull request and wait for public CI to pass.
3. Merge to public `main`.
4. In the private deployment fork, fetch the public upstream and merge or pull
   the updated `main`.
5. Run the private fork validation and deploy from the private fork only.

Public CI should use example club configuration, example branding, and test or
demo service credentials.

## Club-Specific Change

1. Branch from the private deployment fork.
2. Keep the change limited to private config, branding, operational copy, or
   deployment-only behaviour.
3. Open and review the pull request in the private fork.
4. Merge after private CI passes, then deploy from the private fork.

Do not port club-only values, production identifiers, private domains, member
data, or service secrets back into the public upstream.

## Production Hotfix

1. Branch from the private deployment fork.
2. Apply the smallest production fix and deploy from the private fork after its
   validation passes.
3. If any part of the fix is generic, port that subset back to the public
   upstream in a separate public PR.
4. Pull the public PR back into the private fork after it merges, so both
   histories converge.

## CI Expectations

Both repositories should run the same core validation gates:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
git diff --check
```

The public repository should validate with `config/club.example.json` and public
placeholder assets. The private fork should validate with its real
`config/club.json`, private assets, and private CI secrets.

## Post-Split Verification

After the private fork exists, confirm this workflow with one dry run:

1. Merge a trivial documentation change in the public upstream.
2. Pull the public upstream `main` into the private fork.
3. Confirm private CI runs with the private configuration.
4. Deploy only during an approved deployment window.

Record the confirmed command sequence in the private fork README or team memory
used by future development sessions.
