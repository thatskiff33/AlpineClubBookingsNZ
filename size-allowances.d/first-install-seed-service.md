# File-size allowance for the first-install seed commands (#4977)

file: src/lib/setup-readiness.ts
lines: 2288
reason: the seed-admin checklist item now names the Docker seed command beside
  the developer one. The commands and the wording live in
  `src/lib/seed-commands.ts`; what stays here is the one import that the
  existing check reads them through, which no split of this module would remove.
