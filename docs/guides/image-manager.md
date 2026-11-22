# Image Manager

Audience: Operator

## What it is

An uploader and organiser for the images stored in `public/images/` that the
public content editors reference. Find it at **Admin → Setup & Configuration →
Site Appearance & Content → Image Manager** (`/admin/image-manager`). It has no
direct sidebar entry — open it from the **Image Manager** card on the Site
Appearance & Content hub.

Image Manager is edited under the **content** permission area.

## When you'd use it

- You want to upload a photo or logo to use in a public page, footer, or lodge
  content block.
- You want to organise images into folders (e.g. one per page) before linking
  them.
- You need to check which images already exist before re-uploading.

## Step-by-step

### Upload and organise images

1. Open **Image Manager**. The **Directories** panel on the left lists your
   folders (starting at `images/ (root)`); the **Saving to:** line shows where
   new uploads land.

   ![Image Manager showing the Directories panel with images/ (root), the Saving to indicator, and the drag-and-drop upload area noting the accepted formats and size limit](../images/admin/admin-image-manager.png)

2. To upload, **drag & drop images** onto the upload area or **click to select
   files**. Accepted formats are **JPG, PNG, GIF, WebP, and AVIF**, up to
   **10 MB per file**.
3. Use **New** in the Directories panel to create a folder, select a folder to
   change where uploads save, and **Refresh** to reload the current directory's
   listing. Uploaded images can then be inserted from the content editors' Image
   button.
4. With a keyboard, Tab to a folder and press Enter or Space to select it.
   Rename and Delete appear beside the folder while it has keyboard focus or
   the pointer is over it. On touch screens these actions stay visible.

### Hidden details are removed

Photos can carry hidden details: where they were taken, the phone or camera,
the owner's name. The app removes these from every image before saving it, so
nothing hidden is published with your pictures. The picture itself is not
changed: a GIF keeps its animation and a portrait photo stays upright.
[Hidden details in uploaded images](../PRIVACY_RETENTION.md#hidden-details-in-uploaded-images)
lists what is removed for each file type, and the two things that are not.

If the app cannot confirm a file is clean — usually because the file is
damaged or in an unusual form, or because it is an animated AVIF — it refuses
that file and says so. The rest of your upload still goes ahead. Open the image
in an image editor, export a fresh copy, and upload that instead.

### Cleaning an older image

**Images uploaded before this cleaning existed (#5244) are not changed.** They
may still carry hidden details. To clean one, upload it again:

- **An Image Manager image**: download it, then upload it again with the same
  name into the same folder. It replaces the old file, and its link does not
  change, so pages that use it keep working.
- **An image added through a page editor's image picker**: upload it again
  through the picker, point the page at the new copy, then delete the old one
  from the picker.
- **The club logo**: upload it again under **Site Style**.
- **A member photo**: the member, or an admin, uploads it again from the
  member's profile.

**A photo that shows sideways needs its original file.** JPG, PNG and WebP
photos were already cleaned before #5244, and that earlier cleaning also
removed a photo's rotation setting, so a portrait taken on a phone could be
stored sideways. The stored copy no longer has that setting, so downloading it
and uploading it again leaves it sideways. Upload the original file from the
phone or camera instead: the app now keeps the rotation setting, and the photo
shows upright.

**Uploading again does not reach copies made earlier.** An image from the
picker is not replaced: the older one stays stored, and served at its old link,
until you delete it. A browser that has already shown the older image can keep
its own copy, and a database backup taken before the upload still holds an
older picker image, logo or member photo.
[Hidden details in uploaded images](../PRIVACY_RETENTION.md#hidden-details-in-uploaded-images)
says more about both.

### Website-sized copies

When you upload a JPG, PNG or WebP photo, the app also saves smaller copies of
it (400, 800 and 1600 pixels wide, never wider than the photo itself) in a
hidden `.sizes` folder beside it. A
[photo gallery](page-content.md) uses those copies, so a visitor's phone
downloads a thumbnail-sized image rather than your full original. Nothing
changes for you:

- **Your original is kept** and its link is unchanged, so pages that already
  use it keep working.
- **The copies are invisible in Image Manager.** They are never listed, and you
  cannot create, open or delete a `.sizes` folder.
- **They follow the original.** Replacing a photo replaces its copies; deleting
  it deletes them; renaming or deleting a folder carries them.
- **GIF and AVIF files get no copies** (a GIF may be animated; AVIF is already
  small), and neither does a photo that cannot be read. The gallery shows the
  original instead.

Photos uploaded before copies existed have none until an operator runs the
backfill. From a checkout of the app on the server:

1. Find the images folder. In the Docker deployment it is the `image_uploads`
   volume: `docker volume inspect <project>_image_uploads` prints its
   `Mountpoint`.
2. Preview: `pnpm run images:backfill-sizes --root <Mountpoint>`. It lists
   what it would do and writes nothing.
3. Apply: `pnpm run images:backfill-sizes --root <Mountpoint> --apply`. Run as
   root, it gives each copies folder the owner of the folder it sits in, so the
   app can still replace and delete it.
4. Run the preview again: it should report every photo up to date.

It is safe to run again at any time, for example after restoring the images
volume from a backup. It touches only the images folder.

## Settings reference

| Control | What it does | Notes / constraints |
| --- | --- | --- |
| Directories panel | Browse and select the folder under `public/images/` | Root is `images/ (root)` |
| New (directory) | Create a new folder to save into | — |
| Drag & drop / click to select | Upload one or more image files | JPG, PNG, GIF, WebP, AVIF; **max 10 MB per file** |
| Saving to | The folder new uploads are written to | Follows the selected directory |
| Refresh | Reloads the current directory's image list | — |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| An upload is rejected | The file isn't an accepted format or exceeds 10 MB | Convert to JPG/PNG/GIF/WebP/AVIF and keep it under 10 MB |
| An upload is refused because hidden details could not be removed | The file is damaged or in an unusual form, or it is an animated AVIF | Open it in an image editor and export a fresh copy (an animated AVIF as an animated GIF), then upload that. See [Hidden details are removed](#hidden-details-are-removed) |
| An uploaded image doesn't show in the content editor | It's saved in a different folder, or the listing is stale | Check the folder and click **Refresh** |
| I can't find an image I uploaded | It went to the folder shown in **Saving to** at upload time | Select that directory to view it |
| A gallery still downloads full-size photos | Photos uploaded before copies existed, or restored from a backup, have none | Run the backfill in [Website-sized copies](#website-sized-copies) |
| Deleting an image says its resized copies could not be removed | The image storage volume is not writable by the app | Fix the volume's ownership (uid 1001), then run the backfill with `--apply`: it removes copies whose original is gone |
| Everything is read-only | Your admin role can view but not edit under the content area | Ask a full admin for content edit access |

## Related links

- Back to the [documentation hub](../README.md).
- Parent hub: [Site Appearance & Content](appearance.md).
- Sibling guides: [Page Content](page-content.md),
  [Site Content](site-content.md).
