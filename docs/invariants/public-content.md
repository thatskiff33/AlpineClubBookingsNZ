# Public authoritative content

Audience: Developer, Agent.

Prefix defined in this file: **`INV-PUB`** — what the public site is allowed to
publish: fee and policy page content, effective-dated public fees, lodge
token resolution, and the image copies a photo gallery serves.

Read this file when you are changing public fee or policy page content, public
fee resolution, named lodge tokens and the view models built from them, or how
Image Manager photos are stored, copied and served to a gallery.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

## INV-PUB-001

- Fee/policy PageContent blocks are explicitly enabled and server-rendered; a
  token alone publishes nothing.

## INV-PUB-002

- Public fees use current effective-dated schedules. Joining fees resolve from
  the `JoiningFee` schedule (membership type × age tier) only — no legacy Xero
  mapping-amount fallback.

## INV-PUB-003

- Named lodge tokens resolve exactly one active lodge or no data, never the
  default lodge. Public view models exclude ids, provider codes, and secrets.

## INV-PUB-004

The `{{data-hosting}}` page-body token (#4918) publishes only the two values an
admin typed into `PrivacyHostingSettings` (`hostingProvider`, `dataLocation`),
or fixed fallback wording for a blank one. It never derives a value from the
environment, a credential, the backup region, the mail host or a cloud lookup.

- **One sentence, one module.** `dataHostingSentence` in
  `src/lib/privacy-hosting.ts` builds the raw sentence for all four states; the
  renderer escapes the whole sentence once through `escapeHtmlText`, never the
  values first.
- **Plain text only.** Each value is trimmed, one line, no control characters
  or bidi override and isolate controls, at most 120 characters; blank is
  stored as null.
- **Page bodies only.** The catalogue entry allows `page-content-body` and no
  other context.
- **Release boundary.** A release that lacks a token publishes it verbatim, so
  starter text may use `{{data-hosting}}` only in a release after one that
  renders it has shipped.
- Proof: `privacy-hosting.test.ts`, `page-content-embeds.test.ts`,
  `token-catalogue.test.ts`.

## INV-PUB-005

A public photo gallery never makes a visitor download an original it can
replace with a smaller copy, and a copy never outlives or misrepresents its
original. Built to
[#4935](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4935)
(Option A, its build plan).

- **Made at upload, or by the operator's backfill, only.** The Image Manager
  upload writes WebP copies at the fixed widths in `src/lib/image-derivatives.ts`
  — only those narrower than the photo, never an upscale — to the folder's
  hidden `.sizes/` folder. Nothing a visitor requests writes to disk. GIF (may
  be animated) and AVIF get none. A copy that cannot be made is logged and the
  original is served: copies never fail an upload.
- **Re-encoded from the stored bytes**, under the same 50 MP decode ceiling as
  board images, with no metadata carried over.
- **A copy is current only while at least as new as its original.** An older
  one belongs to an earlier file of that name and is never served. If its
  original is replaced mid-write, the writer removes every copy.
- **Copies follow their original.** Deleting an image deletes its copies, and
  a delete that cannot remove them says so rather than reporting success.
  Renaming or deleting a folder carries them. `.sizes` is never listed, never
  an album, and never a folder an officer can name, open or delete.
- **The original is kept and its URL is unchanged.** Stored `/images/*` and
  `/api/images/uploaded/*` URLs keep working; the gallery's full-size view
  opens the widest copy.
- **Served with validators, never as immutable.** File names are reused, so
  `/api/images/uploaded/*` streams the file with an `ETag` and `Last-Modified`
  under a short `max-age`, and answers a matching revalidation with a 304.

Pinned by `image-derivatives.test.ts`, `admin-image-manager-derivatives.test.ts`,
`uploaded-image-route.test.ts`, `page-content-embeds.test.ts` and
`photo-gallery-token.test.tsx`.
