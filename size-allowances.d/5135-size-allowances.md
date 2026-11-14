# Size allowances for #5135

function: src/app/(admin)/admin/system/health/_components/email-deliverability-section.tsx#EmailDeliverabilitySection
lines: 503
reason: adds the Try again button and its confirm dialog, the booking and member
  links, the per-kind guidance on rows that cannot be resent, and the capped-list
  notice to the exhausted email failure list; those lines sit inside the function
  `EmailDeliverabilitySection`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
