- **Hidden details are now removed from every uploaded image, and an image that
  cannot be cleaned is refused (#5244).** Photos can carry where they were
  taken, the phone or camera, and the owner's name. Since v0.14.0 the app
  removed those from JPEG, PNG and WebP uploads, but animated GIFs, AVIF images
  and SVG drawings were stored exactly as uploaded. Now every type is cleaned:
  GIF comments and other hidden blocks are removed (animations keep playing),
  AVIF hidden data is blanked, and SVG drawings are rebuilt from their drawing
  alone, dropping metadata, comments, titles, editor file paths and scripts.

  An image the app cannot confirm clean — a damaged file, an animated AVIF, an
  SVG that loads something from outside itself, or a file that opens like an
  SVG but is not an SVG drawing (for example, its root is not in the SVG
  namespace) — is no longer stored with a
  line in the server log. It is refused with a message asking for a fresh copy
  from an image editor. This applies to the image library, the Image Manager
  (the rest of a batch still uploads), member photos, the club logo, and a
  configuration restore, whose dry run now names the file and blocks Apply.

  Portrait photos taken on a phone now stay upright: their rotation was
  dropped along with the other hidden details. A photo uploaded sideways since
  v0.14.0 needs uploading again.

  Two things are not removed: bytes hidden inside a GIF frame's picture data,
  and the colour profile of a JPEG, PNG, WebP or AVIF, which can name the
  device.
  The privacy guide's "Hidden details in uploaded images" section explains.

  **Images uploaded before this release are not changed** and may still carry
  hidden details. The Image Manager guide's "Cleaning an older image" section
  says how to replace one.
