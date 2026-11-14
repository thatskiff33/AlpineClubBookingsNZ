- **Website photo galleries no longer make visitors download every full-size
  photo (#4935).** A gallery used to send each visitor's browser the original
  of every photo in the folder, often several megabytes each, even for a small
  thumbnail.

  Image Manager now also saves smaller copies of each JPG, PNG or WebP photo
  you upload, and a folder gallery shows the copy that suits the visitor's
  screen. The full-screen viewer opens the largest copy. Your originals are
  kept, their links are unchanged, and the copies never appear in Image
  Manager: they are replaced, deleted and moved with their photo. GIF and AVIF
  files are shown as before. Uploaded images are also cached more efficiently,
  so a returning visitor's browser re-checks a photo instead of downloading it
  again.

  **Operators:** photos uploaded before this release have no copies until you
  run `pnpm run images:backfill-sizes --root <images folder> --apply` once. It
  is safe to repeat; see "Website-sized copies" in the
  [Image Manager guide](../docs/guides/image-manager.md#website-sized-copies).
