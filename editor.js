// Boom Boom photo editor: crop, rotate, draw and add text before a photo is
// sent or turned into a sticker. Doodles use the same editor on a blank page.
// Everything happens on your own device; only the finished picture is sent.

import { decode, cleanPhoto } from './photo.js';

export const COLOURS = ['#FFFFFF', '#191B33', '#E11D48', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#A855F7'];
// Brush and text sizes, in screen pixels (so they look the same zoomed in or out).
export const BRUSHES = { small: 4, medium: 9, large: 18 };
const TEXT_PX = 34;
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const PREVIEW_EDGE = 1600; // the copy you edit on; the full photo is used when sending
const MIN_CROP = 0.08;
const HISTORY_LIMIT = 60;

export function photoItem(file) {
  return { file, rot: 0, crop: null, strokes: [], texts: [], shape: null, history: [], preview: null };
}

export function blankItem(width = 1080, height = 1350, background = '#FFFFFF') {
  return { blank: { width, height, background }, rot: 0, crop: null, strokes: [], texts: [], shape: null, history: [], preview: null };
}

export function isEdited(item) {
  return !!(item.blank || item.rot || item.crop || item.strokes.length || item.texts.length || item.shape);
}

function newCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

// The photo's size (the right way up) without decoding it, if we can tell.
async function photoSize(file) {
  try {
    const info = cleanPhoto(new Uint8Array(await file.arrayBuffer()));
    return [info.width, info.height];
  } catch {
    return [0, 0];
  }
}

// Decodes a photo no bigger than maxPixels (huge photos are shrunk while
// decoding, so phones don't run out of memory).
async function decodeAtMost(file, maxPixels) {
  const [w, h] = await photoSize(file);
  const scale = w && h ? Math.min(1, Math.sqrt(maxPixels / (w * h))) : 1;
  return decode(file, scale < 1 ? Math.max(1, Math.round(w * scale)) : 0);
}

// A screen-sized copy of the photo to edit on.
export async function loadPreview(item) {
  if (item.blank || item.preview) return item.preview;
  const full = await decodeAtMost(item.file, PREVIEW_EDGE * PREVIEW_EDGE);
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(full.width, full.height));
  if (scale === 1) {
    item.preview = full;
    return full;
  }
  const c = newCanvas(Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, c.width, c.height);
  full.close?.();
  item.preview = c;
  return c;
}

export function releasePreview(item) {
  item.preview?.close?.();
  item.preview = null;
}

function sourceSize(item, src) {
  return item.blank ? [item.blank.width, item.blank.height] : [src.width, src.height];
}

function turned(item, w, h) {
  return item.rot % 180 ? [h, w] : [w, h];
}

const isLight = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150;
};

const textFont = (px) => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

function drawStroke(ctx, s, W, H, unit) {
  const pts = s.points;
  const width = s.size * unit;
  ctx.strokeStyle = s.colour;
  ctx.fillStyle = s.colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * W, pts[0][1] * H, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
  for (let i = 1; i < pts.length - 1; i++) { // smooth curve through the midpoints
    ctx.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, ((pts[i][0] + pts[i + 1][0]) / 2) * W, ((pts[i][1] + pts[i + 1][1]) / 2) * H);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] * W, last[1] * H);
  ctx.stroke();
}

function drawText(ctx, t, W, H, unit) {
  const px = t.size * unit;
  ctx.font = textFont(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.16;
  ctx.strokeStyle = isLight(t.colour) ? '#000000' : '#FFFFFF';
  ctx.strokeText(t.text, t.x * W, t.y * H);
  ctx.fillStyle = t.colour;
  ctx.fillText(t.text, t.x * W, t.y * H);
}

// Draws the picture (turned, cropped, with drawings and text) filling outW × outH.
export function paint(ctx, item, src, outW, outH, { crop = true } = {}) {
  const [sw, sh] = sourceSize(item, src);
  const [W, H] = turned(item, sw, sh);
  const c = crop && item.crop ? item.crop : FULL;
  ctx.save();
  ctx.scale(outW / (c.w * W), outH / (c.h * H));
  ctx.translate(-c.x * W, -c.y * H);
  if (item.blank) {
    ctx.fillStyle = item.blank.background;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((item.rot * Math.PI) / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }
  const unit = Math.min(W, H);
  for (const s of item.strokes) drawStroke(ctx, s, W, H, unit);
  for (const t of item.texts) drawText(ctx, t, W, H, unit);
  ctx.restore();
}

function shapePath(ctx, shape, x, y, w, h) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    const r = Math.min(w, h) * 0.18;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// The finished picture, at full quality, ready to send.
//   type: 'image/jpeg' | 'image/png' | 'image/webp'
//   size: an exact square size (stickers); otherwise the full resolution,
//         capped at maxPixels (phone browsers can't draw bigger canvases).
export async function exportItem(item, { type = 'image/jpeg', quality = 0.95, maxPixels = 16_000_000, size = 0 } = {}) {
  const src = item.blank ? null : await decodeAtMost(item.file, maxPixels);
  try {
    const [sw, sh] = sourceSize(item, src);
    const [W, H] = turned(item, sw, sh);
    const c = item.crop || FULL;
    const w = c.w * W;
    const h = c.h * H;
    let outW;
    let outH;
    if (size) {
      outW = size;
      outH = Math.max(1, Math.round((size * h) / w));
    } else {
      const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
      outW = Math.max(1, Math.round(w * scale));
      outH = Math.max(1, Math.round(h * scale));
    }
    const canvas = newCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, outW, outH);
    }
    paint(ctx, item, src, outW, outH);
    if (item.shape && item.shape !== 'square') {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      shapePath(ctx, item.shape, 0, 0, outW, outH);
      ctx.fill();
      ctx.restore();
    }
    return await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't save the picture."))), type, quality));
  } finally {
    src?.close?.();
  }
}

// ---------------------------------------------------------------------
//  The editing surface
// ---------------------------------------------------------------------

export class Editor {
  constructor(canvas, { onChange = () => {}, onText = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.item = null;
    this.src = null;
    this.mode = 'view'; // view | crop | draw | text
    this.colour = COLOURS[2];
    this.brush = BRUSHES.medium;
    this.aspect = null; // null = free, or width ÷ height in pixels (1 = square)
    this.onChange = onChange;
    this.onText = onText;
    this.drag = null;
    this.frame = 0;
    this.loading = 0;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e, false));
    canvas.addEventListener('pointercancel', (e) => this.up(e, true));
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.queue()).observe(canvas.parentElement);
    }
  }

  async show(item) {
    const token = ++this.loading;
    this.item = item;
    this.src = null;
    this.drag = null;
    this.queue();
    const src = await loadPreview(item);
    if (token !== this.loading) return;
    this.src = src;
    if (this.mode === 'crop') this.startCrop();
    this.render();
  }

  get ready() { return !!this.item && (this.item.blank || !!this.src); }

  size() {
    return turned(this.item, ...sourceSize(this.item, this.src));
  }

  setMode(mode) {
    if (this.mode === 'crop' && mode !== 'crop') this.endCrop();
    this.mode = mode;
    if (mode === 'crop') this.startCrop();
    this.queue();
  }

  setAspect(aspect) {
    this.aspect = aspect;
    if (this.mode === 'crop' && this.ready && aspect) {
      this.remember();
      this.item.crop = this.fitAspect(this.item.crop || { ...FULL });
      this.changed();
    }
  }

  // The biggest box of the chosen shape that fits inside `c`, centred on it.
  fitAspect(c) {
    const [W, H] = this.size();
    let w = c.w;
    let h = (c.w * W) / this.aspect / H;
    if (h > c.h) { h = c.h; w = (c.h * H * this.aspect) / W; }
    return { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h };
  }

  startCrop() {
    if (!this.ready) return;
    if (!this.item.crop) this.item.crop = { ...FULL };
    if (this.aspect) {
      const [W, H] = this.size();
      const c = this.item.crop;
      if (Math.abs((c.w * W) / (c.h * H) - this.aspect) > 0.01) this.item.crop = this.fitAspect(c);
    }
  }

  endCrop() {
    const c = this.item?.crop;
    if (c && c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999) this.item.crop = null;
  }

  remember() {
    const { rot, crop, strokes, texts, shape } = this.item;
    this.item.history.push(JSON.stringify({ rot, crop, strokes, texts, shape }));
    if (this.item.history.length > HISTORY_LIMIT) this.item.history.shift();
  }

  get canUndo() { return !!this.item?.history.length; }

  undo() {
    const last = this.item?.history.pop();
    if (!last) return;
    Object.assign(this.item, JSON.parse(last));
    if (this.mode === 'crop') this.startCrop();
    this.changed();
  }

  rotate() {
    if (!this.ready) return;
    this.remember();
    const it = this.item;
    it.rot = (it.rot + 90) % 360;
    const turn = ([x, y]) => [1 - y, x]; // a quarter turn clockwise
    for (const s of it.strokes) s.points = s.points.map(turn);
    for (const t of it.texts) [t.x, t.y] = turn([t.x, t.y]);
    if (it.crop) it.crop = { x: 1 - (it.crop.y + it.crop.h), y: it.crop.x, w: it.crop.h, h: it.crop.w };
    if (this.mode === 'crop') this.startCrop();
    this.changed();
  }

  setShape(shape) {
    if (!this.item || this.item.shape === shape) return;
    this.remember();
    this.item.shape = shape;
    this.changed();
  }

  // Add, change or (with empty text) remove a piece of text.
  setText(t, value, at = null) {
    const text = (value || '').trim().slice(0, 80);
    const it = this.item;
    if (!it || (!t && !text) || (t && t.text === text)) return;
    this.remember();
    if (t && !text) it.texts.splice(it.texts.indexOf(t), 1);
    else if (t) t.text = text;
    else it.texts.push({ text, colour: this.colour, x: at?.[0] ?? 0.5, y: at?.[1] ?? 0.5, size: this.scaled(TEXT_PX) });
    this.changed();
  }

  setColour(colour) {
    this.colour = colour;
  }

  changed() {
    this.queue();
    this.onChange();
  }

  // Screen pixels → a size relative to the picture.
  scaled(px) {
    const [W, H] = this.size();
    const c = this.mode === 'crop' ? FULL : (this.item.crop || FULL);
    return (px * c.w * W) / (Math.min(W, H) * this.view.w);
  }

  layout() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(box.width));
    const ch = Math.max(1, Math.round(box.height));
    if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
    }
    this.dpr = dpr;
    this.cssW = cw;
    this.cssH = ch;
    const pad = this.mode === 'crop' ? 22 : 6;
    const [W, H] = this.size();
    const c = this.mode === 'crop' ? FULL : (this.item.crop || FULL);
    const aspect = (c.w * W) / (c.h * H);
    let w = Math.max(1, cw - pad * 2);
    let h = w / aspect;
    if (h > ch - pad * 2) {
      h = Math.max(1, ch - pad * 2);
      w = h * aspect;
    }
    this.view = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  queue() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.ready) return;
    this.layout();
    const v = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.translate(v.x, v.y);
    paint(ctx, this.item, this.src, v.w, v.h, { crop: this.mode !== 'crop' });
    ctx.restore();
    if (this.mode === 'crop') this.drawCrop();
    else if (this.item.shape && this.item.shape !== 'square') {
      ctx.save(); // show the sticker's shape by dimming what gets cut off
      ctx.fillStyle = 'rgba(7, 8, 15, 0.7)';
      ctx.beginPath();
      ctx.rect(v.x, v.y, v.w, v.h);
      shapePath(ctx, this.item.shape, v.x, v.y, v.w, v.h);
      ctx.fill('evenodd');
      ctx.restore();
    }
  }

  cropBox() {
    const v = this.view;
    const c = this.item.crop || FULL;
    return { x: v.x + c.x * v.w, y: v.y + c.y * v.h, w: c.w * v.w, h: c.h * v.h };
  }

  drawCrop() {
    const { ctx } = this;
    const v = this.view;
    const b = this.cropBox();
    ctx.save();
    ctx.fillStyle = 'rgba(7, 8, 15, 0.6)';
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(b.x + b.w * f, b.y); ctx.lineTo(b.x + b.w * f, b.y + b.h);
      ctx.moveTo(b.x, b.y + b.h * f); ctx.lineTo(b.x + b.w, b.y + b.h * f);
    }
    ctx.stroke();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    const L = Math.min(22, b.w / 3, b.h / 3);
    for (const [x, y, dx, dy] of [[b.x, b.y, 1, 1], [b.x + b.w, b.y, -1, 1], [b.x, b.y + b.h, 1, -1], [b.x + b.w, b.y + b.h, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Pointer position as [x, y] across the turned (uncropped) picture, 0–1.
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left - this.view.x;
    const py = e.clientY - r.top - this.view.y;
    const c = this.mode === 'crop' ? FULL : (this.item.crop || FULL);
    return [c.x + (px / this.view.w) * c.w, c.y + (py / this.view.h) * c.h];
  }

  screen([x, y]) {
    const c = this.item.crop || FULL;
    return [this.view.x + ((x - c.x) / c.w) * this.view.w, this.view.y + ((y - c.y) / c.h) * this.view.h];
  }

  textAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const [W, H] = this.size();
    const c = this.item.crop || FULL;
    const scale = this.view.w / (c.w * W);
    for (let i = this.item.texts.length - 1; i >= 0; i--) {
      const t = this.item.texts[i];
      const px = t.size * Math.min(W, H) * scale;
      this.ctx.font = textFont(px);
      const w = this.ctx.measureText(t.text).width + px * 0.6;
      const [cx, cy] = this.screen([t.x, t.y]);
      if (Math.abs(sx - cx) <= w / 2 && Math.abs(sy - cy) <= px * 0.8) return t;
    }
    return null;
  }

  cropHandle(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const b = this.cropBox();
    const near = 28;
    const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    let best = null;
    let bestD = near;
    for (const [name, [x, y]] of Object.entries(corners)) {
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) { best = name; bestD = d; }
    }
    if (best) return best;
    if (sx > b.x && sx < b.x + b.w && sy > b.y && sy < b.y + b.h) return 'move';
    return null;
  }

  down(e) {
    if (!this.ready || this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const p = this.point(e);
    if (this.mode === 'draw') {
      this.remember();
      const stroke = { colour: this.colour, size: this.scaled(this.brush), points: [p] };
      this.item.strokes.push(stroke);
      this.drag = { kind: 'draw', stroke, id: e.pointerId };
    } else if (this.mode === 'text') {
      const t = this.textAt(e);
      this.drag = { kind: 'text', t, start: p, orig: t ? [t.x, t.y] : null, moved: false, id: e.pointerId, sx: e.clientX, sy: e.clientY };
    } else if (this.mode === 'crop') {
      const handle = this.cropHandle(e);
      if (!handle) return;
      this.remember();
      this.drag = { kind: 'crop', handle, start: p, orig: { ...(this.item.crop || FULL) }, id: e.pointerId };
    } else {
      return;
    }
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
    this.queue();
  }

  move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.point(e);
    if (d.kind === 'draw') {
      const last = d.stroke.points[d.stroke.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.0015) d.stroke.points.push(p);
    } else if (d.kind === 'text' && d.t) {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      if (!d.moved) { d.moved = true; this.remember(); }
      d.t.x = Math.min(1, Math.max(0, d.orig[0] + p[0] - d.start[0]));
      d.t.y = Math.min(1, Math.max(0, d.orig[1] + p[1] - d.start[1]));
    } else if (d.kind === 'crop') {
      this.item.crop = this.dragCrop(d, p);
    } else if (d.kind === 'text' && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 6) {
      d.moved = true;
    }
    this.queue();
  }

  up(e, cancelled) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (d.kind === 'text' && !d.moved && !cancelled) this.onText(d.t, d.start);
    this.changed();
  }

  dragCrop(d, p) {
    const o = d.orig;
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    if (d.handle === 'move') {
      return { x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h), w: o.w, h: o.h };
    }
    let x0 = o.x;
    let y0 = o.y;
    let x1 = o.x + o.w;
    let y1 = o.y + o.h;
    const west = d.handle.includes('w');
    const north = d.handle.includes('n');
    if (west) x0 = clamp(x0 + dx, 0, x1 - MIN_CROP); else x1 = clamp(x1 + dx, x0 + MIN_CROP, 1);
    if (north) y0 = clamp(y0 + dy, 0, y1 - MIN_CROP); else y1 = clamp(y1 + dy, y0 + MIN_CROP, 1);
    if (this.aspect) {
      const [W, H] = this.size();
      let w = x1 - x0;
      let h = (w * W) / this.aspect / H;
      const room = north ? y1 : 1 - y0; // how far the moving edge can go
      if (h > room) { h = room; w = (h * H * this.aspect) / W; }
      if (west) x0 = x1 - w; else x1 = x0 + w;
      if (north) y0 = y1 - h; else y1 = y0 + h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}
