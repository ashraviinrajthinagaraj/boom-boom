// Boom Boom — photo privacy.
//
// Before a photo leaves your phone, Boom Boom removes the hidden details
// cameras store inside it: GPS location, phone make and model, date and
// time, editing software, comments, and embedded previews. For JPEG, PNG,
// WebP and GIF this is done WITHOUT re-compressing: the picture data is
// copied byte for byte, so the photo keeps its full original quality. Only
// two things are kept: the colour profile (so colours look right) and the
// rotation flag (so the photo isn't sideways). Other formats (like HEIC) are
// converted to a high-quality JPEG, which drops all hidden details too.

export const MAX_PHOTO_BYTES = 50 * 1024 * 1024; // Supabase Free plan limit per file

export class PhotoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function detectType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && ascii(b, 1, 3) === 'PNG' && b[0] === 0x89) return 'png';
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length > 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  return null;
}

// ---------------------------------------------------------------------
//  JPEG
// ---------------------------------------------------------------------

function readExifOrientation(seg) {
  // seg = APP1 payload starting with "Exif\0\0"
  if (seg.length < 14 || ascii(seg, 0, 4) !== 'Exif') return 1;
  const t = 6; // TIFF header start
  const little = seg[t] === 0x49; // "II"
  const r16 = (i) => (little ? seg[i] | (seg[i + 1] << 8) : u16be(seg, i));
  const r32 = (i) => (little ? u32le(seg, i) : u32be(seg, i));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > seg.length) return 1;
  const count = r16(ifd);
  for (let n = 0; n < count; n++) {
    const e = ifd + 2 + n * 12;
    if (e + 12 > seg.length) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

// A tiny EXIF block holding only the rotation flag.
function orientationOnlyApp1(orientation) {
  const data = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01,                                     // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
    0x00, orientation, 0x00, 0x00,                  // value
    0x00, 0x00, 0x00, 0x00,                         // no next IFD
  ];
  const len = data.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...data]);
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function cleanJpeg(b) {
  const keep = [new Uint8Array([0xff, 0xd8])];
  let jfif = null;
  let orientation = 1;
  let width = 0;
  let height = 0;
  let pos = 2;
  let ended = false;

  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new PhotoError('damaged', 'This photo looks damaged.');
    while (b[pos] === 0xff) pos++; // fill bytes
    const marker = b[pos++];
    const start = pos - 2;

    if (marker === 0xd9) { keep.push(new Uint8Array([0xff, 0xd9])); ended = true; break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { keep.push(new Uint8Array([0xff, marker])); continue; }

    if (pos + 2 > b.length) throw new PhotoError('damaged', 'This photo looks damaged.');
    const len = u16be(b, pos);
    const end = pos + len;
    if (len < 2 || end > b.length) throw new PhotoError('damaged', 'This photo looks damaged.');
    const payload = b.subarray(pos + 2, end);
    const segment = b.subarray(start, end);

    if (marker === 0xe0) {
      // JFIF header: keep, but without any embedded thumbnail.
      if (ascii(payload, 0, 5) === 'JFIF\0' && payload.length >= 14) {
        jfif = new Uint8Array([0xff, 0xe0, 0x00, 0x10, ...payload.subarray(0, 12), 0x00, 0x00]);
      }
    } else if (marker === 0xe1) {
      if (ascii(payload, 0, 4) === 'Exif') orientation = readExifOrientation(payload);
      // EXIF and XMP dropped
    } else if (marker === 0xe2) {
      if (ascii(payload, 0, 12) === 'ICC_PROFILE\0') keep.push(segment); // colour profile
    } else if (marker === 0xee) {
      if (ascii(payload, 0, 5) === 'Adobe') keep.push(segment); // needed to decode some colours
    } else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) {
      // other app data (IPTC, Photoshop, maker notes...) and comments dropped
    } else {
      if (SOF_MARKERS.has(marker) && payload.length >= 5) {
        height = u16be(payload, 1);
        width = u16be(payload, 3);
      }
      keep.push(segment);
      if (marker === 0xda) {
        // Compressed picture data: copy it as-is up to the next real marker.
        let i = end;
        while (i < b.length) {
          if (b[i] === 0xff) {
            const next = b[i + 1];
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
            if (next === 0xff) { i += 1; continue; }
            break;
          }
          i++;
        }
        keep.push(b.subarray(end, i));
        pos = i;
        continue;
      }
    }
    pos = end;
  }

  if (!ended || !width || !height) throw new PhotoError('damaged', 'This photo looks damaged.');
  // Anything after the end of the picture (e.g. phone-maker extras) is dropped.
  const head = [keep[0]];
  if (jfif) head.push(jfif);
  if (orientation !== 1) head.push(orientationOnlyApp1(orientation));
  const bytes = join([...head, ...keep.slice(1)]);
  const swap = orientation >= 5;
  return { bytes, orientation, width: swap ? height : width, height: swap ? width : height };
}

// ---------------------------------------------------------------------
//  PNG
// ---------------------------------------------------------------------

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI']);

export function cleanPng(b) {
  const keep = [b.subarray(0, 8)];
  let pos = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  while (pos + 12 <= b.length) {
    const len = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    const end = pos + 12 + len;
    if (end > b.length) throw new PhotoError('damaged', 'This photo looks damaged.');
    if (type === 'IHDR') { width = u32be(b, pos + 8); height = u32be(b, pos + 12); }
    if (PNG_KEEP.has(type)) keep.push(b.subarray(pos, end)); // text, EXIF, dates dropped
    pos = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !width || !height) throw new PhotoError('damaged', 'This photo looks damaged.');
  return { bytes: join(keep), orientation: 1, width, height };
}

// ---------------------------------------------------------------------
//  WebP
// ---------------------------------------------------------------------

export function cleanWebp(b) {
  const keep = [];
  let pos = 12;
  let width = 0;
  let height = 0;
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  while (pos + 8 <= riffEnd) {
    const type = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > b.length) throw new PhotoError('damaged', 'This photo looks damaged.');
    const data = b.subarray(pos + 8, pos + 8 + size);
    if (type === 'EXIF' || type === 'XMP ') { pos = end; continue; } // dropped
    const chunk = b.slice(pos, Math.min(end, b.length));
    if (type === 'VP8X') {
      chunk[8] &= ~(0x08 | 0x04); // no EXIF / XMP any more
      width = u24le(data, 4) + 1;
      height = u24le(data, 7) + 1;
    } else if (type === 'VP8 ' && !width && data.length >= 10) {
      width = (data[6] | (data[7] << 8)) & 0x3fff;
      height = (data[8] | (data[9] << 8)) & 0x3fff;
    } else if (type === 'VP8L' && !width && data.length >= 5) {
      const bits = u32le(data, 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    keep.push(chunk);
    pos = end;
  }
  if (!width || !height) throw new PhotoError('damaged', 'This photo looks damaged.');
  const body = join(keep);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  const size = body.length + 4;
  header.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return { bytes: join([header, body]), orientation: 1, width, height };
}

// ---------------------------------------------------------------------
//  GIF (keeps animation; drops comments and app data except looping)
// ---------------------------------------------------------------------

export function cleanGif(b) {
  const damaged = () => new PhotoError('damaged', 'This photo looks damaged.');
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  let pos = 13;
  if (b[10] & 0x80) pos += 3 * (1 << ((b[10] & 0x07) + 1));
  const keep = [b.subarray(0, pos)];
  const skipSubBlocks = (i) => {
    while (i < b.length && b[i] !== 0) i += b[i] + 1;
    if (i >= b.length) throw damaged();
    return i + 1;
  };
  for (;;) {
    if (pos >= b.length) throw damaged();
    const intro = b[pos];
    if (intro === 0x3b) { keep.push(new Uint8Array([0x3b])); break; }
    if (intro === 0x21) {
      const label = b[pos + 1];
      const end = skipSubBlocks(pos + 2);
      let keepIt = label === 0xf9 || label === 0x01;
      if (label === 0xff) {
        const id = ascii(b, pos + 3, 11);
        keepIt = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
      }
      if (keepIt) keep.push(b.subarray(pos, end));
      pos = end;
    } else if (intro === 0x2c) {
      let i = pos + 10;
      if (b[pos + 9] & 0x80) i += 3 * (1 << ((b[pos + 9] & 0x07) + 1));
      const end = skipSubBlocks(i + 1);
      keep.push(b.subarray(pos, end));
      pos = end;
    } else {
      throw damaged();
    }
  }
  if (!width || !height) throw damaged();
  return { bytes: join(keep), orientation: 1, width, height };
}

// ---------------------------------------------------------------------
//  Entry points
// ---------------------------------------------------------------------

const FORMATS = {
  jpeg: { clean: cleanJpeg, mime: 'image/jpeg', ext: 'jpg' },
  png: { clean: cleanPng, mime: 'image/png', ext: 'png' },
  webp: { clean: cleanWebp, mime: 'image/webp', ext: 'webp' },
  gif: { clean: cleanGif, mime: 'image/gif', ext: 'gif' },
};

// Returns { bytes, type, mime, ext, width, height, orientation }, with
// width/height as the photo is shown (after rotation).
export function cleanPhoto(bytes) {
  const type = detectType(bytes);
  if (!type) throw new PhotoError('unsupported', 'This photo format needs converting.');
  const f = FORMATS[type];
  return { ...f.clean(bytes), type, mime: f.mime, ext: f.ext };
}

// ---------------------------------------------------------------------
//  Browser-only helpers
// ---------------------------------------------------------------------

async function decode(blob, targetWidth) {
  if (targetWidth) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: targetWidth, resizeQuality: 'high' });
    } catch { /* fall back to a full decode */ }
  }
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

async function canvasToJpeg(bitmap, width, height, quality) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; // transparent areas become white
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
}

// Small preview shown in the chat (the full photo opens when tapped).
export async function makeThumbnail(blob, width, height, maxEdge = 960) {
  const scale = Math.min(1, maxEdge / Math.max(width || maxEdge, height || maxEdge));
  const bitmap = await decode(blob, width ? Math.max(1, Math.round(width * scale)) : 0);
  const s = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  try {
    return await canvasToJpeg(bitmap, w, h, 0.82);
  } finally {
    bitmap.close?.();
  }
}

// For formats we can't clean byte-for-byte (HEIC, AVIF...): convert to a
// high-quality JPEG, which carries no hidden details at all.
export async function convertToJpeg(blob) {
  let bitmap;
  try {
    bitmap = await decode(blob, 0);
  } catch {
    throw new PhotoError('unsupported', "This photo's format can't be sent. Try a JPEG or PNG, or take a screenshot of it.");
  }
  const maxPixels = 16_000_000; // phone browsers can't draw bigger canvases
  const scale = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  try {
    const out = await canvasToJpeg(bitmap, width, height, 0.95);
    return { bytes: new Uint8Array(await out.arrayBuffer()), type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', width, height, orientation: 1 };
  } finally {
    bitmap.close?.();
  }
}

// Profile picture: a centred square, 512×512, re-saved as JPEG (which also
// drops every hidden detail the original carried).
export async function makeAvatar(file, size = 512) {
  let width = 0;
  let height = 0;
  try {
    const info = cleanPhoto(new Uint8Array(await file.arrayBuffer()));
    width = info.width;
    height = info.height;
  } catch { /* other formats: decode at full size below */ }
  let bitmap;
  try {
    const scale = width && height ? Math.min(1, size / Math.min(width, height)) : 1;
    bitmap = await decode(file, width && scale < 1 ? Math.round(width * scale) : 0);
  } catch {
    throw new PhotoError('unsupported', "That picture's format can't be used. Try a JPEG or PNG.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.max(1, Math.min(size, side));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(out, out) : Object.assign(document.createElement('canvas'), { width: out, height: out });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close?.();
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.88));
}

// Everything needed to send one photo.
export async function preparePhoto(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  let cleaned;
  try {
    cleaned = cleanPhoto(raw);
  } catch (error) {
    if (error.code !== 'unsupported') throw error;
    cleaned = await convertToJpeg(file);
  }
  if (cleaned.bytes.length > MAX_PHOTO_BYTES) {
    throw new PhotoError('too-big', 'That photo is over 50 MB, which is too big to send.');
  }
  const original = new Blob([cleaned.bytes], { type: cleaned.mime });
  const thumb = await makeThumbnail(original, cleaned.width, cleaned.height);
  return { original, thumb, ext: cleaned.ext, mime: cleaned.mime, width: cleaned.width, height: cleaned.height };
}
