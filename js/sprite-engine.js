// ACT/SPR parsing and anchor/render logic adapted from ragnarok-database-builder.
// Copyright (c) 2026 Manuuuu21. MIT; see ../LICENSE.
import { parseSpr as readSpr, parseAct as readAct, rgbaImage } from './sprite-formats.js';

function bufferOf(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new TypeError('Expected an ACT/SPR ArrayBuffer or typed array.');
}
export const parseSpr = value => readSpr(bufferOf(value));
export const parseAct = value => readAct(bufferOf(value));
export { rgbaImage };
export function createPart(sprBuffer, actBuffer, metadata = {}) {
  return { ...metadata, spr: parseSpr(sprBuffer), act: parseAct(actBuffer) };
}
export const ACTIONS = { idle: 0, sit: 16 };
export const DIRECTIONS = ['South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast', 'East', 'Southeast'];

export function actionProblems(parts, action = 'idle') {
  if (!(action in ACTIONS)) return ['Choose Idle or Sit.'];
  const problems = [];
  if (!parts.some(part => part.kind === 'body')) problems.push('Choose a job sprite.');
  for (const part of parts) {
    const missing = DIRECTIONS.filter((_, direction) => !part.act?.actions[ACTIONS[action] + direction]?.frames?.length);
    if (missing.length) problems.push(`${part.name || part.kind || 'Sprite'} has no ${action} frames for ${missing.join(', ')}.`);
  }
  return problems;
}
export const supportsAction = (parts, action) => actionProblems(parts, action).length === 0;

function imageFor(spr, layer) {
  if (layer.index < 0) return null;
  if (![0, 1].includes(layer.type)) throw new Error(`Unsupported sprite layer type ${layer.type}.`);
  const image = spr.images[layer.index + (layer.type ? spr.indexedCount : 0)];
  if (!image || image.type !== layer.type) throw new Error(`ACT references missing sprite image ${layer.index}.`);
  return image;
}
export function layerMatrix(layer) {
  const r = layer.rotation * Math.PI / 180, sx = layer.sx * (layer.mirror ? -1 : 1);
  return [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * layer.sy, Math.cos(r) * layer.sy];
}
function hiddenMarker(spr, layer) {
  const image = imageFor(spr, layer);
  return layer.y >= 100 && image?.width === 1 && image.height === 1 && Math.abs(layer.sx) <= 1 && Math.abs(layer.sy) <= 1;
}
// Idle/sit player actions contain three consecutive head-look variants. Only
// the first look variant belongs in an NPC's selected idle/sit animation.
export function poseFrameCount(action) {
  return action.frames.length % 3 === 0 ? action.frames.length / 3 : action.frames.length;
}
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const lcm = (a, b) => a / gcd(a, b) * b;
function timeline(actions) {
  const durations = actions.map(action => Math.max(1, Math.round(action.delay)));
  const counts = actions.map(poseFrameCount);
  const animated = counts.map((count, i) => count > 1 ? i : -1).filter(i => i >= 0);
  if (!animated.length) return { count: 1, delay: durations[0], durations, counts };
  const delay = animated.map(i => durations[i]).reduce(gcd);
  let cycle = 1;
  for (const i of animated) {
    cycle = lcm(cycle, counts[i] * durations[i]);
    if (cycle / delay > 600 || cycle > 120000) throw new Error('These animated parts have incompatible cycle lengths. Remove an animated accessory to export a complete loop.');
  }
  return { count: cycle / delay, delay, durations, counts };
}
function layerOrder(parts, direction) {
  const index = kind => parts.map((part, i) => part.kind === kind ? i : -1).filter(i => i >= 0);
  const body = index('body'), head = index('head');
  const gear = parts.map((part, i) => !['body', 'head', 'garment'].includes(part.kind) ? i : -1).filter(i => i >= 0);
  // Lower accessories first, then middle, then top; costume precedence is
  // resolved by the editor before passing the visible parts here.
  const weight = { lower: 0, costumeLower: 0, mid: 1, costumeMid: 1, top: 2, costumeTop: 2 };
  gear.sort((a, b) => (weight[parts[a].kind] ?? 1) - (weight[parts[b].kind] ?? 1));
  const garments = index('garment');
  if (direction < 3 || direction > 5) return [...garments, ...body, ...head, ...gear];
  const normal = garments.filter(i => !parts[i].topLayer), top = garments.filter(i => parts[i].topLayer);
  return [...body, ...normal, ...head, ...gear, ...top];
}
export function measureFrames(parts, frames, padding = 2) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const frame of frames) for (let i = 0; i < parts.length; i++) for (const layer of frame[i]) {
    const image = imageFor(parts[i].spr, layer);
    if (!image || !layer.color[3]) continue;
    const [a, b, c, d] = layerMatrix(layer), left = -Math.floor(image.width / 2), top = -Math.floor(image.height / 2);
    for (const x of [left, left + image.width]) for (const y of [top, top + image.height]) {
      const px = layer.x + a * x + c * y, py = layer.y + b * x + d * y;
      minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
  }
  if (!Number.isFinite(minX)) throw new Error('This pose has no visible sprite layers.');
  minX = Math.floor(minX) - padding; minY = Math.floor(minY) - padding;
  const width = Math.ceil(maxX) + padding - minX, height = Math.ceil(maxY) + padding - minY;
  if (width > 4096 || height > 4096 || width * height > 4000000) throw new Error('This sprite exceeds the supported canvas size.');
  return { minX, minY, width, height, scale: 1 };
}
export function composeCharacter(parts, { action = 'idle', direction = 0 } = {}) {
  if (!Number.isInteger(direction) || direction < 0 || direction > 7) throw new Error('Choose one of the eight directions.');
  const problems = actionProblems(parts, action);
  if (problems.length) throw new Error(problems.join(' '));
  const body = parts.findIndex(part => part.kind === 'body');
  const actions = parts.map(part => part.act.actions[ACTIONS[action] + direction]);
  const timing = timeline(actions);
  const frames = Array.from({ length: timing.count }, (_, frame) => {
    const indices = actions.map((_, i) => Math.floor(frame * timing.delay / timing.durations[i]) % timing.counts[i]);
    const bodyAnchor = actions[body].anchors?.[indices[body]]?.[0];
    return actions.map((partAction, i) => {
      const source = partAction.anchors?.[indices[i]]?.[0];
      const attached = parts[i].kind !== 'body' && parts[i].kind !== 'garment';
      const dx = attached && source && bodyAnchor ? bodyAnchor.x - source.x : 0;
      const dy = attached && source && bodyAnchor ? bodyAnchor.y - source.y : 0;
      return partAction.frames[indices[i]]
        .filter(layer => !attached || parts[i].kind === 'head' || !hiddenMarker(parts[i].spr, layer))
        .map(layer => ({ ...layer, x: layer.x + dx, y: layer.y + dy }));
    });
  });
  return { parts, action, direction, frames, delay: timing.delay, order: layerOrder(parts, direction), bounds: measureFrames(parts, frames) };
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}
const renderCaches = new WeakMap();
function renderImage(part, layer) {
  const image = imageFor(part.spr, layer);
  if (!image) return null;
  let cache = renderCaches.get(part);
  if (!cache) { cache = new Map(); renderCaches.set(part, cache); }
  const key = `${layer.type}:${layer.index}:${layer.color.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const data = rgbaImage(part.spr, image);
  for (let p = 0; p < data.length; p += 4) for (let c = 0; c < 4; c++) data[p + c] = Math.round(data[p + c] * layer.color[c] / 255);
  const canvas = makeCanvas(image.width, image.height);
  const context = canvas.getContext('2d'), pixels = context.createImageData(image.width, image.height);
  pixels.data.set(data); context.putImageData(pixels, 0, 0);
  if (cache.size >= 256) cache.clear();
  cache.set(key, canvas);
  return canvas;
}
export function drawComposition(canvas, composition, { frameIndex = 0, scale = 3, background = null } = {}) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 16) throw new Error('Invalid preview scale.');
  const { parts, frames, order, bounds } = composition;
  const width = Math.max(1, Math.ceil(bounds.width * scale)), height = Math.max(1, Math.ceil(bounds.height * scale));
  if (width > 8192 || height > 8192 || width * height > 32000000) throw new Error('This preview is too large. Reduce the zoom.');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.imageSmoothingEnabled = false;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  const frame = frames[((Math.floor(frameIndex) % frames.length) + frames.length) % frames.length];
  for (const i of order) for (const layer of frame[i]) {
    if (!layer.color[3]) continue;
    const image = renderImage(parts[i], layer);
    if (!image) continue;
    const [a, b, c, d] = layerMatrix(layer);
    ctx.setTransform(a * scale, b * scale, c * scale, d * scale, (layer.x - bounds.minX) * scale, (layer.y - bounds.minY) * scale);
    ctx.drawImage(image, -Math.floor(image.width / 2), -Math.floor(image.height / 2));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx;
}
export function drawPartThumbnail(canvas, part, { direction = 0, action = 'idle', size = 64 } = {}) {
  const source = part.act.actions[ACTIONS[action] + direction];
  if (!source?.frames.length) throw new Error('This preview direction is unavailable.');
  const frame = source.frames[0].filter(layer => !hiddenMarker(part.spr, layer));
  const bounds = measureFrames([part], [[frame]]);
  return drawComposition(canvas, { parts: [part], frames: [[frame]], order: [0], bounds }, { scale: Math.min(3, size / Math.max(bounds.width, bounds.height)) });
}
