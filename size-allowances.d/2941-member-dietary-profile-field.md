# File-size allowances for #2941 (DIETARY 1)

Dietary/allergy information touches every existing member writer and reader,
each by a few lines; the shared logic lives in the new src/lib/member-dietary.ts.

file: src/app/(admin)/admin/members/_components/member-editor-dialog.tsx
lines: 1292
reason: the create-only dietary input and its request key sit beside the occupation field they mirror; the form has no other seam to host them.

file: src/app/(authenticated)/profile/page.tsx
lines: 692
reason: one gated read through the dietary door and two props; the page is the server boundary that decides whether the key reaches the client, so it cannot move out.

file: src/app/api/admin/members/export/route.ts
lines: 545
reason: the dietary column must be decided inside the same column list as the other optional fields so header and rows stay aligned; the value comes from the dietary module.

file: src/app/api/admin/members/import/route.ts
lines: 802
reason: the dietary value is validated, gated and written inside the existing all-or-nothing row pipeline; splitting one field out would fork that pipeline.

file: src/app/api/member/data-export/route.ts
lines: 366
reason: the subject's own export must include the value (owner decision 20 Sep 2026); it is one read through the dietary door plus its explanation.

file: src/app/api/member/onboarding/route.ts
lines: 274
reason: one gated self read and two response keys, placed beside the occupation keys the wizard already consumes.

file: src/app/api/profile/route.ts
lines: 532
reason: the self writer must build its patch and changed-field evidence inside the same transaction and audit row as the other profile fields.

file: src/lib/admin-member-detail-service.ts
lines: 1748
reason: the admin reader and writer thread the dietary grant through the existing detail GET/PUT; the value logic itself lives in src/lib/member-dietary.ts.

file: src/lib/admin-members-service.ts
lines: 1782
reason: create stores the dietary patch in the same member.create as every other field; the patch builder lives in src/lib/member-dietary.ts.

file: src/lib/audit-retention.ts
lines: 810
reason: the archive client must carry the same omit as every application client so the census holds with no exemption; five lines at the constructor.

file: src/lib/audit.ts
lines: 958
reason: the audit sanitizer is the one place metadata is sanitised; the dietary-key backstop and its INV-PRIV-011 carve-out note must sit beside the credential rules.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1168
reason: the toggle joins the existing member-fields singleton spec, whose fields and constraints must stay in one declaration.

file: src/lib/member-csv-import.ts
lines: 1111
reason: the dietary column joins the field definitions, mapping and per-row validation tables, which are single declarations the whole parser iterates.

file: src/lib/member-merge.ts
lines: 3122
reason: the engine must attach both dietary values at each of its three derivation points and redact the audit row; the helpers were moved into src/lib/member-dietary.ts, leaving only the calls.

file: src/lib/redact-sensitive-json.ts
lines: 897
reason: the two dietary/allergy key fragments belong in the one redactor key list; a second list is what INV-PRIV-011 forbids.
