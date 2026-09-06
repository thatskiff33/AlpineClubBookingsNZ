# File-size allowance for #3255

file: src/app/(admin)/admin/fees/_components/hut-fees-section.tsx
lines: 965
reason: the scroll-on-Edit call has to sit inside startEdit, beside the state
  change that reveals the form it scrolls to; the seven lines are a ref, the
  existing hook, the call, and the comment saying why the scroll exists.
  Splitting this component is a refactor of its own and would not remove a
  line of this fix.
