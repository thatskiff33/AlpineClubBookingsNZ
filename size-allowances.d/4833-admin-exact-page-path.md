# File-size allowances for admin page URLs served only at their exact spelling (#4801)

The rule lives in the hub registry (`isInexactAdminPagePath`); two
already-over-budget files each gain the lines that apply it, where every other
check on the same path already sits.

file: src/proxy.ts
lines: 1215
reason: one import and a two-line commented call at the head of the module
  gate, which already answers a page path with the shared 404 document before
  anything else reads it. The check has to run there, before the request
  reaches the app; moving it out would split one path decision across two
  places in the proxy.

file: src/lib/admin-permissions.ts
lines: 951
reason: one commented line at the top of `canOpenAdminPathWithMatrix`, the
  single admission rule the layout guard, the sidebar and the palette all
  ask. A fail-closed refusal belongs inside that rule, not beside each caller.
