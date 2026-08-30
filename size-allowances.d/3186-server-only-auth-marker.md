# File-size allowances for #2850 / #2851

Both entries are the same eleven-ish lines: `import "server-only"` plus the
comment that says what the marker does, why the production build refuses the
module in a browser bundle, and why the operator CLIs that reach it run with
`--conditions=react-server`. None of it is logic, and the marker cannot move —
Next keys the boundary on the specifier appearing in the file's own graph, so
re-exporting it from a smaller module would not protect this one.

file: src/lib/auth.ts
lines: 829
reason: splitting `auth.ts` to accommodate a comment would be the tail wagging
  the dog, and the marker has to sit in this file rather than in a module it
  imports, because Next keys the boundary on this file's own graph.

file: src/lib/audit.ts
lines: 755
reason: the audit writer is one cohesive module and #2850 adds no logic to it,
  only the `server-only` marker and the seven comment lines explaining it;
  splitting a 745-line module to make room for a comment would trade a real
  refactor's risk for a formatting win.
