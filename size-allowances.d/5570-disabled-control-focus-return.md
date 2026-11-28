# Size allowances for #5570

file: src/components/profile/family-group-section.tsx
lines: 1158
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. This file was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.

function: src/app/(authenticated)/profile/partner-link-section.tsx#PartnerLinkSection
lines: 322
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. The function `PartnerLinkSection` was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.

function: src/app/(public)/login/login-form.tsx#LoginForm
lines: 408
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. The function `LoginForm` was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.

function: src/components/profile/family-group-section.tsx#FamilyGroupSection
lines: 1011
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. The function `FamilyGroupSection` was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.

function: src/components/profile/profile-form.tsx#ProfileForm
lines: 317
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. The function `ProfileForm` was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.

function: src/components/promo-code-list.tsx#PromoCodeList
lines: 352
reason: returns keyboard focus to a control disabled while its request
  runs (#5442): an import, the hook, and a capture and release line per
  handler. The function `PromoCodeList` was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.
