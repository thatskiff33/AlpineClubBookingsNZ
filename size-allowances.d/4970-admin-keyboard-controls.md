# File-size allowances for #4970

file: src/app/(admin)/admin/system/audit-log/page.tsx
lines: 1110
reason: the expand button with its aria-expanded state and label has to sit
  inside the row it expands; the page has no row component to move it to, and
  extracting one is a refactor of its own, outside an accessibility fix.

file: src/app/(admin)/admin/website/image-manager/image-manager-client.tsx
lines: 741
reason: each folder row becomes a real button with separate named Rename and
  Delete buttons; they share the row's selection and permission state, and
  splitting the folder list out would only move that state behind props.

file: src/components/admin/page-content-panel.tsx
lines: 2618
reason: the nine lines are the accessible name and read-only state on the
  editor's own contentEditable element and HTML textarea; they cannot live
  anywhere but on those elements.
