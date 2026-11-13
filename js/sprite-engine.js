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
// Standard player ACT group indices. Additional groups are discovered from the
// body instead of being discarded. These labels describe the player layout.
export const ACTION_DEFINITIONS = [
  ['idle', 'Idle'], ['walk', 'Walking'], ['sit', 'Sitting'], ['pickup', 'Picking up'],
  ['ready', 'Combat ready'], ['attack', 'Attacking 1'], ['hurt', 'Taking damage'],
  ['freeze', 'Frozen'], ['dead', 'Dead'], ['freeze2', 'Frozen 2'],
  ['attack2', 'Attacking 2'], ['attack3', 'Attacking 3'], ['cast', 'Casting / skill'],
].map(([id, label], index) => ({ id, label, index, base: index * 8 }));
export const ACTIONS = Object.fromEntries(ACTION_DEFINITIONS.map(action => [action.id, action.base]));
export const DIRECTIONS = ['South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast', 'East', 'Southeast'];

function groupDefinition(index) {
  return ACTION_DEFINITIONS[index] || { id: `action-${index}`, label: `Additional action ${index}`, index, base: index * 8 };
}
function actionBase(action) {
  if (Object.hasOwn(ACTIONS, action)) return ACTIONS[action];
  const match = typeof action === 'string' && /^action-(\d+)$/.exec(action);
  if (match && Number(match[1]) < 125) return Number(match[1]) * 8;
  return null;
}
export function actionLabel(action) {
  const base = actionBase(action);
  return base === null ? 'Unknown action' : groupDefinition(base / 8).label;
}
function partWarnings(parts, base, directions) {
  const label = groupDefinition(Math.floor(base / 8)).label;
  return parts.filter(part => part.kind !== 'body').flatMap(part => {
    const missing = directions.filter(direction => !part.act?.actions[base + direction]?.frames?.length);
    return missing.length ? [`${part.name || part.kind || 'Sprite'} has no ${label} frames for ${missing.map(direction => DIRECTIONS[direction]).join(', ')} and is omitted in those directions.`] : [];
  });
}
export function enumerateActions(parts) {
  const body = parts.find(part => part.kind === 'body');
  const actions = body?.act?.actions || [];
  return Array.from({ length: Math.ceil(actions.length / 8) }, (_, index) => {
    const definition = groupDefinition(index);
    const directions = DIRECTIONS.map((_, direction) => direction).filter(direction => actions[definition.base + direction]?.frames?.length);
    return { ...definition, directions,
      supportedDirections: directions.filter(direction => parts.every(part => part.act?.actions[definition.base + direction]?.frames?.length)),
      warnings: partWarnings(parts, definition.base, directions),
      problems: directions.length ? [] : [`${definition.label} has no frames in this job sprite.`],
    };
  });
}
export function actionProblems(parts, action = 'idle', direction) {
  const body = parts.find(part => part.kind === 'body');
  if (!body) return ['Choose a job sprite.'];
  const base = actionBase(action);
  if (base === null) return ['Choose an action available in this job sprite.'];
  if (direction !== undefined) {
    if (!Number.isInteger(direction) || direction < 0 || direction > 7) return ['Choose one of the eight directions.'];
    if (!body.act?.actions[base + direction]?.frames?.length) return [`${actionLabel(action)} has no ${DIRECTIONS[direction]} frames in this job sprite.`];
  } else if (!body.act?.actions?.slice(base, base + 8).some(source => source?.frames?.length)) {
    return [`${actionLabel(action)} is unavailable in this job sprite.`];
  }
  return [];
}
export const supportsAction = (parts, action, direction) => actionProblems(parts, action, direction).length === 0;

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
function timeline(actions, body, neutral) {
  const durations = actions.map(action => Math.max(1, neutral ? Math.round(action?.delay || 1) : action?.delay || 1));
  const counts = actions.map(action => action ? (neutral ? poseFrameCount(action) : action.frames.length) : 0);
  // Movement and combat follow the body frame clock. Per-accessory delays can
  // differ even for matching walking poses; playing those independently makes
  // hats and hair lag behind the body's movement.
  if (!neutral) return { count: counts[body], delay: durations[body], durations, counts };
  const animated = counts.map((count, i) => count > 1 ? i : -1).filter(i => i >= 0);
  if (!animated.length) return { count: 1, delay: durations[body], durations, counts };
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
  const problems = actionProblems(parts, action, direction);
  if (problems.length) throw new Error(problems.join(' '));
  return composeAction(parts, { actionIndex: actionBase(action) + direction });
}
// Exports use exact source indices, including intentional empty slots. Missing
// optional part actions are omitted and reported, never replaced by another pose.
export function composeAction(parts, { actionIndex, allowEmpty = false } = {}) {
  const body = parts.findIndex(part => part.kind === 'body');
  if (body < 0) throw new Error('Choose a job sprite.');
  if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= parts[body].act.actions.length) throw new Error('This source action index is unavailable.');
  const definition = groupDefinition(Math.floor(actionIndex / 8));
  const direction = actionIndex % 8;
  const base = { parts, action: definition.id, label: definition.label, actionIndex, direction, order: layerOrder(parts, direction) };
  const sourceBody = parts[body].act.actions[actionIndex];
  const blankBounds = { minX: 0, minY: 0, width: 1, height: 1, scale: 1 };
  if (!sourceBody?.frames?.length) {
    if (!allowEmpty) throw new Error(`${definition.label} has no ${DIRECTIONS[direction]} frames in this job sprite.`);
    return { ...base, frames: [], delay: Math.max(1, sourceBody?.delay || 96), bounds: blankBounds, empty: true, warnings: [] };
  }
  const actions = parts.map(part => part.act?.actions[actionIndex]?.frames?.length ? part.act.actions[actionIndex] : null);
  const neutral = definition.id === 'idle' || definition.id === 'sit';
  const timing = timeline(actions, body, neutral);
  let composedLayers = 0;
  const frames = Array.from({ length: timing.count }, (_, frame) => {
    const indices = actions.map((_, i) => !timing.counts[i] ? -1 : neutral
      ? Math.floor(frame * timing.delay / timing.durations[i]) % timing.counts[i]
      : definition.id === 'walk' ? frame % timing.counts[i] : Math.min(frame, timing.counts[i] - 1));
    const bodyAnchor = actions[body].anchors?.[indices[body]]?.[0];
    return actions.map((partAction, i) => {
      if (!partAction) return [];
      const source = partAction.anchors?.[indices[i]]?.[0];
      const attached = parts[i].kind !== 'body' && parts[i].kind !== 'garment';
      const dx = attached && source && bodyAnchor ? bodyAnchor.x - source.x : 0;
      const dy = attached && source && bodyAnchor ? bodyAnchor.y - source.y : 0;
      const layers = partAction.frames[indices[i]]
        .filter(layer => !attached || parts[i].kind === 'head' || !hiddenMarker(parts[i].spr, layer));
      composedLayers += layers.length;
      if (composedLayers > 500000) throw new Error(`${definition.label} exceeds the supported composition size. Remove an animated accessory to reduce its size.`);
      return layers.map(layer => ({ ...layer, x: layer.x + dx, y: layer.y + dy }));
    });
  });
  const visible = frames.some(frame => frame.some(layers => layers.some(layer => layer.index >= 0 && layer.color[3])));
  return { ...base, frames, delay: timing.delay, bounds: visible ? measureFrames(parts, frames) : blankBounds,
    empty: false, warnings: partWarnings(parts, definition.base, [direction]) };
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
  if (!frames.length) return ctx;
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
  const base = actionBase(action);
  const source = base === null ? null : part.act.actions[base + direction];
  if (!source?.frames.length) throw new Error('This preview direction is unavailable.');
  const frame = source.frames[0].filter(layer => !hiddenMarker(part.spr, layer));
  const bounds = measureFrames([part], [[frame]]);
  return drawComposition(canvas, { parts: [part], frames: [[frame]], order: [0], bounds }, { scale: Math.min(3, size / Math.max(bounds.width, bounds.height)) });
}
