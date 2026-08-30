# File-size allowances for #2850 / #2851

file: src/lib/auth.ts
lines: 828
reason: the marker is `import "server-only"` plus the eight comment lines that
  say what it does, why the build refuses this module in a browser bundle, and
  where the reasoning for its sibling `@/lib/prisma` NOT carrying it is written
  down. Eleven lines, none of them logic. Splitting `auth.ts` to accommodate a
  comment would be the tail wagging the dog, and the marker cannot move: Next
  keys the boundary on the specifier appearing in this file's own graph, so a
  re-export from a smaller module would not protect this one.
