- **The repository now installs with pnpm instead of npm (#3673).** pnpm keeps
  one copy of each package version in a shared store on the machine and links it
  into every checkout, so a second worktree no longer costs another gigabyte and
  a full download. The layout is strict: code may only import packages
  `package.json` declares. For a developer: install pnpm once (`npm install -g
  pnpm@11` or `corepack enable pnpm`), then use `pnpm install --frozen-lockfile`
  where you used `npm ci`, `pnpm run <script>` for `npm run <script>`, and
  `pnpm exec <tool>` for `npx <tool>`; `npm install` now refuses to run here on
  purpose. The lockfile is `pnpm-lock.yaml`, and the dependency overrides and
  install-script allowlist moved to `pnpm-workspace.yaml`. The resolved versions
  are carried over from npm's lockfile; pnpm only merged two nested `lru-cache`
  patch copies onto the one already in the tree. The Docker image, CI and the dependency audit use pnpm
  too; a club deploying with `docker compose build` needs no change. See
  "Package manager: pnpm" in [CONTRIBUTING.md](../CONTRIBUTING.md).
