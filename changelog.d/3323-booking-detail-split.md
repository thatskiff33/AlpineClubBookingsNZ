- **Maintainability: the member/admin booking-detail page is decomposed by
  domain responsibility with no change in behaviour.** The 2,761-line route
  page now keeps only the shell — sign-in, the club clock, the booking read,
  the viewer gate and the order of its sections — and hands the rest to
  route-local modules: ten server-side loading/projection modules (who is
  looking, consent, history, edit access, linked party, payment, the edit
  panel's payload, booking messages, admin-tools reads) and ten render
  sections (status banners, admin tools, consent cards, linked-party sections,
  review notices, stay preferences, payment cards, lifecycle actions,
  cancellation outcome, notes and history). Every moved line is the same line;
  every permission, view-only gate, payment surface and error state renders
  exactly as before. (#2958)
