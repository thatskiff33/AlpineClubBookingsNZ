/**
 * Hidden-data removal for still AVIF images (#5244), behind
 * `stripImageMetadata` in `@/lib/image-metadata`.
 *
 * AVIF is an ISO-BMFF (HEIF) container: a run of boxes, each a 32-bit size and
 * a four-letter type. EXIF (with GPS) and XMP are stored as *items* — entries
 * in the `meta` box's item list whose bytes sit in `mdat` or `idat` beside the
 * picture — and editors add more in properties and unknown boxes.
 *
 * Every change is a same-length overwrite in place, so no box size and no
 * offset in the item-location table (`iloc`) moves and the picture's bytes are
 * untouched:
 *  - a box that is not needed to draw the picture is retyped `free` and its
 *    body zeroed (`free` is the format's own "ignore me" box);
 *  - an item that is not a picture (`Exif`, `mime` for XMP, `uri `, …) is
 *    retyped `free` in the item list, and every byte after the type in each
 *    item entry (its name, MIME type, encoding) is zeroed;
 *  - every byte of `mdat` and `idat` that no picture item points at is zeroed,
 *    which is where the EXIF and XMP payloads themselves lived;
 *  - the handler's name string, any data-reference location (a file path) and
 *    the file type's minor version are zeroed, and an unknown brand is
 *    replaced by `mif1`.
 *
 * Lossless, and a second pass returns identical bytes.
 *
 * Fail-CLOSED: any structural doubt — a truncated or overrunning box, no
 * `ftyp` first, not exactly one `meta`, a handler other than `pict`, an
 * item-entry or item-location version this does not parse, an external data
 * reference, a zero-length or out-of-container extent — returns `unconfirmed`.
 * An animated AVIF (a `moov`/`moof` track) returns `animated`: its frames live
 * in a track whose hidden-data boxes this does not walk.
 */

const IMAGE_ITEM_TYPES = new Set(["av01", "grid", "iovl", "iden", "tmap"]);
const META_CHILDREN_KEPT = new Set([
  "hdlr", "pitm", "iloc", "iinf", "iref", "iprp", "idat", "dinf", "grpl",
]);
const PROPERTIES_KEPT = new Set([
  "av1C", "ispe", "pixi", "colr", "irot", "imir", "clap", "pasp", "auxC",
  "a1op", "a1lx", "lsel", "clli", "mdcv", "cclv", "amve",
]);
const ANIMATION_BOXES = new Set(["moov", "moof"]);
// File-type brands an AVIF declares; any other four letters could be text.
const KNOWN_BRANDS = new Set([
  "avif", "avis", "avio", "mif1", "mif2", "mif3", "miaf", "MA1A", "MA1B",
  "msf1", "iso8", "heic", "heix", "tmap",
]);

export type AvifStripOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "unconfirmed" | "animated" };

class MalformedAvif extends Error {}
class AnimatedAvif extends Error {}

type Box = { type: string; start: number; body: number; end: number };
type Range = readonly [start: number, end: number];

function byteAt(bytes: Buffer, offset: number, limit: number): number {
  const value = bytes[offset];
  if (value === undefined || offset >= limit) throw new MalformedAvif("truncated");
  return value;
}

function childBoxes(bytes: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new MalformedAvif("truncated box header");
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new MalformedAvif("truncated large size");
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(end - offset)) throw new MalformedAvif("large size overrun");
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) throw new MalformedAvif(`bad ${type} size`);
    boxes.push({ type, start: offset, body: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function blank(bytes: Buffer, box: Box): void {
  bytes.write("free", box.start + 4, "latin1");
  bytes.fill(0, box.body, box.end);
}

/** Zero every byte of [start, end) that no kept range covers. */
function zeroOutside(bytes: Buffer, start: number, end: number, kept: Range[]): void {
  let cursor = start;
  for (const [from, to] of [...kept].sort((a, b) => a[0] - b[0])) {
    if (from > cursor) bytes.fill(0, cursor, from);
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) bytes.fill(0, cursor, end);
}

/** The file-type box with its minor version zeroed and unknown brands replaced. */
function scrubFileType(bytes: Buffer, ftyp: Box): void {
  const length = ftyp.end - ftyp.body;
  if (length < 8 || length % 4 !== 0) throw new MalformedAvif("file type size");
  bytes.writeUInt32BE(0, ftyp.body + 4); // minor version
  for (let at = ftyp.body + 8; at < ftyp.end; at += 4) {
    if (!KNOWN_BRANDS.has(bytes.toString("latin1", at, at + 4))) bytes.write("mif1", at, "latin1");
  }
}

/**
 * The data-reference box with every location string zeroed and each entry
 * marked "in this file". Item extents must use reference 0 (this file), so no
 * entry is ever followed; what is zeroed is only text, such as a file path.
 */
function scrubDataInformation(bytes: Buffer, dinf: Box): void {
  for (const child of childBoxes(bytes, dinf.body, dinf.end)) {
    if (child.type !== "dref") {
      blank(bytes, child);
      continue;
    }
    for (const entry of childBoxes(bytes, child.body + 8, child.end)) {
      if (entry.type !== "url " && entry.type !== "urn ") throw new MalformedAvif("data entry type");
      if (entry.body + 4 > entry.end) throw new MalformedAvif("truncated data entry");
      bytes[entry.body + 3] = byteAt(bytes, entry.body + 3, entry.end) | 0x01;
      bytes.fill(0, entry.body + 4, entry.end);
    }
  }
}

/** Item ids mapped to whether the item is a picture; non-picture items blanked. */
function scrubItemInfo(bytes: Buffer, iinf: Box): Map<number, boolean> {
  const items = new Map<number, boolean>();
  const version = byteAt(bytes, iinf.body, iinf.end);
  const entriesStart = iinf.body + 4 + (version === 0 ? 2 : 4);
  for (const entry of childBoxes(bytes, entriesStart, iinf.end)) {
    if (entry.type !== "infe") throw new MalformedAvif("item list child");
    const entryVersion = byteAt(bytes, entry.body, entry.end);
    if (entryVersion !== 2 && entryVersion !== 3) throw new MalformedAvif("item entry version");
    const idBytes = entryVersion === 2 ? 2 : 4;
    const typeOffset = entry.body + 4 + idBytes + 2; // + protection index
    if (typeOffset + 4 > entry.end) throw new MalformedAvif("truncated item entry");
    const id = entryVersion === 2
      ? bytes.readUInt16BE(entry.body + 4)
      : bytes.readUInt32BE(entry.body + 4);
    const isPicture = IMAGE_ITEM_TYPES.has(bytes.toString("latin1", typeOffset, typeOffset + 4));
    if (!isPicture) bytes.write("free", typeOffset, "latin1");
    bytes.fill(0, typeOffset + 4, entry.end); // item name, content type, encoding
    if (items.has(id)) throw new MalformedAvif("duplicate item id");
    items.set(id, isPicture);
  }
  return items;
}

/** File ranges (`mdat`) and `idat`-relative ranges holding picture items. */
function pictureExtents(
  bytes: Buffer,
  iloc: Box,
  pictures: Map<number, boolean>,
): { file: Range[]; idat: Range[] } {
  const file: Range[] = [];
  const idat: Range[] = [];
  let offset = iloc.body;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 256 + byteAt(bytes, offset + i, iloc.end);
    offset += count;
    return value;
  };
  const version = read(1);
  if (version > 2) throw new MalformedAvif("item location version");
  read(3); // flags
  const sizes = read(1);
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0x0f;
  const moreSizes = read(1);
  const baseOffsetSize = moreSizes >> 4;
  const indexSize = version > 0 ? moreSizes & 0x0f : 0;
  const itemCount = read(version < 2 ? 2 : 4);
  for (let i = 0; i < itemCount; i += 1) {
    const id = read(version < 2 ? 2 : 4);
    const method = version > 0 ? read(2) & 0x0f : 0;
    if (method > 1) throw new MalformedAvif("construction method");
    if (read(2) !== 0) throw new MalformedAvif("external data reference");
    const baseOffset = read(baseOffsetSize);
    const extentCount = read(2);
    for (let x = 0; x < extentCount; x += 1) {
      read(indexSize);
      const extentOffset = baseOffset + read(offsetSize);
      const length = read(lengthSize);
      if (length === 0) throw new MalformedAvif("zero-length extent");
      if (!pictures.get(id)) continue;
      (method === 0 ? file : idat).push([extentOffset, extentOffset + length]);
    }
  }
  return { file, idat };
}

function scrubAvif(source: Buffer): Buffer {
  const bytes = Buffer.from(source);
  const top = childBoxes(bytes, 0, bytes.length);
  const ftyp = top[0];
  if (ftyp?.type !== "ftyp") throw new MalformedAvif("no ftyp");
  if (top.some((box) => ANIMATION_BOXES.has(box.type))) throw new AnimatedAvif("animated");
  scrubFileType(bytes, ftyp);
  const metas = top.filter((box) => box.type === "meta");
  const meta = metas[0];
  if (!meta || metas.length !== 1) throw new MalformedAvif("meta count");

  let pictures: Map<number, boolean> | null = null;
  let iloc: Box | null = null;
  let idat: Box | null = null;
  for (const child of childBoxes(bytes, meta.body + 4, meta.end)) {
    if (!META_CHILDREN_KEPT.has(child.type)) {
      blank(bytes, child);
    } else if (child.type === "hdlr") {
      if (child.body + 24 > child.end) throw new MalformedAvif("truncated handler");
      if (bytes.toString("latin1", child.body + 8, child.body + 12) !== "pict") {
        throw new MalformedAvif("handler");
      }
      bytes.fill(0, child.body + 24, child.end); // handler name
    } else if (child.type === "dinf") {
      scrubDataInformation(bytes, child);
    } else if (child.type === "iinf") {
      if (pictures) throw new MalformedAvif("second item list");
      pictures = scrubItemInfo(bytes, child);
    } else if (child.type === "iloc") {
      if (iloc) throw new MalformedAvif("second item location table");
      iloc = child;
    } else if (child.type === "idat") {
      if (idat) throw new MalformedAvif("second idat");
      idat = child;
    } else if (child.type === "iprp") {
      for (const part of childBoxes(bytes, child.body, child.end)) {
        if (part.type === "ipco") {
          for (const property of childBoxes(bytes, part.body, part.end)) {
            if (!PROPERTIES_KEPT.has(property.type)) blank(bytes, property);
          }
        } else if (part.type !== "ipma") {
          throw new MalformedAvif("property container child");
        }
      }
    }
  }
  if (!pictures || !iloc) throw new MalformedAvif("no item list or location table");

  const extents = pictureExtents(bytes, iloc, pictures);
  const mdats = top.filter((box) => box.type === "mdat");
  for (const [from, to] of extents.file) {
    if (!mdats.some((box) => from >= box.body && to <= box.end)) {
      throw new MalformedAvif("picture extent outside mdat");
    }
  }
  for (const box of top) {
    if (box.type === "ftyp" || box.type === "meta") continue;
    if (box.type === "mdat") {
      zeroOutside(bytes, box.body, box.end, extents.file.filter(
        ([from, to]) => from >= box.body && to <= box.end,
      ));
    } else {
      blank(bytes, box);
    }
  }
  if (extents.idat.length > 0 && !idat) throw new MalformedAvif("idat extent without idat");
  if (idat) {
    const body = idat.body;
    const ranges = extents.idat.map(([from, to]): Range => [body + from, body + to]);
    if (ranges.some(([, to]) => to > idat.end)) throw new MalformedAvif("extent outside idat");
    zeroOutside(bytes, idat.body, idat.end, ranges);
  }
  return bytes;
}

/**
 * The still AVIF with every non-picture item, property and box blanked in
 * place, or the reason it could not be confirmed clean.
 */
export function stripAvifMetadata(bytes: Buffer): AvifStripOutcome {
  try {
    return { ok: true, bytes: scrubAvif(bytes) };
  } catch (error) {
    if (error instanceof AnimatedAvif) return { ok: false, reason: "animated" };
    if (error instanceof MalformedAvif || error instanceof RangeError) {
      return { ok: false, reason: "unconfirmed" };
    }
    throw error;
  }
}
