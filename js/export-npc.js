import { composeAction, enumerateActions, rgbaImage, drawComposition, DIRECTIONS } from './sprite-engine.js';

const ZIP_LIMIT = 128 * 1024 * 1024;
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

class Writer {
  constructor(length) { this.bytes = new Uint8Array(length); this.view = new DataView(this.bytes.buffer); this.offset = 0; }
  u8(n) { this.view.setUint8(this.offset++, n); }
  u16(n) { this.view.setUint16(this.offset, n, true); this.offset += 2; }
  u32(n) { this.view.setUint32(this.offset, n, true); this.offset += 4; }
  i32(n) { this.view.setInt32(this.offset, n, true); this.offset += 4; }
  f32(n) { this.view.setFloat32(this.offset, n, true); this.offset += 4; }
  put(bytes) { this.bytes.set(bytes, this.offset); this.offset += bytes.length; }
  skip(n) { this.offset += n; }
}
function usedImage(spr, layer) {
  if (layer.index < 0) return null;
  const index = layer.index + (layer.type ? spr.indexedCount : 0);
  const image = spr.images[index];
  if (!image || image.type !== layer.type) throw new Error('An ACT layer refers to a missing SPR image.');
  return { index, image };
}

function sourceActionCount(parts) {
  const count = parts.find(part => part.kind === 'body')?.act?.actions?.length;
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Choose a job with a supported ACT action table.');
  return count;
}

function exportSelection(parts, actionIds) {
  const count = sourceActionCount(parts), groups = enumerateActions(parts);
  const available = groups.filter(group => group.directions.length);
  if (actionIds !== undefined && (!Array.isArray(actionIds) || !actionIds.length)) throw new Error('Select at least one job action to export.');
  const selected = new Set(actionIds === undefined ? available.map(group => group.id) : actionIds);
  if ([...selected].some(id => !available.some(group => group.id === id))) throw new Error('Choose actions available in the selected job.');
  const all = available.every(group => selected.has(group.id));
  const compact = !all || (actionIds !== undefined && selected.size === 1);
  const selectedGroups = compact ? groups.filter(group => selected.has(group.id)) : groups;
  const indices = new Set(selectedGroups.flatMap(group => Array.from({ length: Math.min(8, count - group.base) }, (_, direction) => group.base + direction)));
  return { count, groups: selectedGroups, indices, all, compact };
}

// Compose using source indices, then write only the selected groups in order.
// A single selected action starts at ACT 0, with its direction slots intact.
export function buildNpcBinary(parts, { actionIds } = {}) {
  const selection = exportSelection(parts, actionIds);
  const compositions = [], totals = { frames: 0, layers: 0 };
  for (const actionIndex of selection.indices) collectComposition(parts, actionIndex, compositions, totals);
  return assembleBinary(parts, compositions);
}

function collectComposition(parts, actionIndex, compositions, totals) {
  const composition = composeAction(parts, { actionIndex, allowEmpty: true });
  totals.frames += composition.frames.length;
  for (const frame of composition.frames) for (const layers of frame) totals.layers += layers.length;
  if (totals.frames > 50000 || totals.layers > 500000) throw new Error('The complete action set exceeds the supported frame or layer export limit.');
  compositions.push(composition);
}

// Each source can have its own 256-color palette. Convert referenced images to
// native true-color SPR images so no quantization or palette merging loses color.
function assembleBinary(parts, compositions) {
  const images = [], remaps = parts.map(() => new Map());
  let pixels = 0, layerCount = 0, frameCount = 0;
  for (const composition of compositions) {
    frameCount += composition.frames.length;
    if (frameCount > 50000) throw new Error('The complete action set exceeds the 50,000-frame export limit.');
  }
  const actions = compositions.map(composition => ({
    delay: composition.delay,
    frames: composition.frames.map(frame => composition.order.flatMap(partIndex => frame[partIndex].flatMap(layer => {
      if (layer.index < 0 || !layer.color[3]) return [];
      if (++layerCount > 500000) throw new Error('The complete action set has too many layers to export.');
      if (![layer.x, layer.y].every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('A composed layer is outside the supported ACT coordinate range.');
      const { index, image } = usedImage(parts[partIndex].spr, layer);
      let newIndex = remaps[partIndex].get(index);
      if (newIndex === undefined) {
        newIndex = images.length; remaps[partIndex].set(index, newIndex);
        pixels += image.width * image.height;
        if (images.length >= 10000 || pixels > 16000000) throw new Error('The selected sprites exceed the NPC export size limit.');
        images.push({ width: image.width, height: image.height, rgba: rgbaImage(parts[partIndex].spr, image) });
      }
      return [{ ...layer, type: 1, index: newIndex, width: image.width, height: image.height }];
    }))),
  }));
  if (!images.length) throw new Error('The selected job has no visible sprite layers to export.');
  const sprSize = 8 + images.reduce((size, image) => size + 4 + image.width * image.height * 4, 0) + 1024;
  const spr = new Writer(sprSize);
  spr.put(new Uint8Array([83, 80, 0, 2])); spr.u16(0); spr.u16(images.length);
  for (const image of images) {
    spr.u16(image.width); spr.u16(image.height);
    // Ragnarok stores true-color pixels bottom-up in A,B,G,R order.
    for (let y = image.height - 1; y >= 0; y--) for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4;
      spr.u8(image.rgba[p + 3]); spr.u8(image.rgba[p + 2]); spr.u8(image.rgba[p + 1]); spr.u8(image.rgba[p]);
    }
  }
  spr.skip(1024);
  const actSize = 16 + actions.reduce((size, direction) => size + 4 + direction.frames.reduce((n, layers) => n + 44 + layers.length * 44, 0), 0) + 4 + actions.length * 4;
  const act = new Writer(actSize);
  act.put(new Uint8Array([65, 67, 5, 2])); act.u16(actions.length); act.skip(10);
  for (const direction of actions) {
    act.u32(direction.frames.length);
    for (const layers of direction.frames) {
      act.skip(32); act.u32(layers.length);
      for (const layer of layers) {
        act.i32(layer.x); act.i32(layer.y); act.i32(layer.index); act.i32(layer.mirror ? 1 : 0);
        act.put(Uint8Array.from(layer.color)); act.f32(layer.sx); act.f32(layer.sy); act.i32(layer.rotation); act.i32(1);
        act.i32(layer.width); act.i32(layer.height);
      }
      act.i32(-1); // No player sound event in the generated NPC.
      act.u32(0); // All parts are already attached to the body's origin.
    }
  }
  act.u32(0);
  for (const direction of actions) act.f32(direction.delay / 24);
  if (act.offset !== actSize || spr.offset !== sprSize) throw new Error('The export writer produced an invalid length.');
  const warnings = [...new Set(compositions.flatMap(composition => composition.warnings || []))];
  return { spr: spr.bytes, act: act.bytes, actions, compositions, imageCount: images.length, warnings };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(file => ({ name: encoder.encode(file.name), bytes: typeof file.bytes === 'string' ? encoder.encode(file.bytes) : file.bytes }));
  const length = 22 + entries.reduce((n, file) => n + 76 + file.name.length * 2 + file.bytes.length, 0);
  if (length > ZIP_LIMIT) throw new Error('The export archive exceeds 128 MB.');
  const writer = new Writer(length), offsets = [];
  const now = new Date(), date = Math.max(0, now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
  const time = now.getHours() << 11 | now.getMinutes() << 5 | Math.floor(now.getSeconds() / 2);
  for (const file of entries) {
    offsets.push(writer.offset); file.crc = crc32(file.bytes);
    writer.u32(0x04034b50); writer.u16(20); writer.u16(0x800); writer.u16(0); writer.u16(time); writer.u16(date);
    writer.u32(file.crc); writer.u32(file.bytes.length); writer.u32(file.bytes.length); writer.u16(file.name.length); writer.u16(0);
    writer.put(file.name); writer.put(file.bytes);
  }
  const directoryOffset = writer.offset;
  entries.forEach((file, i) => {
    writer.u32(0x02014b50); writer.u16(20); writer.u16(20); writer.u16(0x800); writer.u16(0); writer.u16(time); writer.u16(date);
    writer.u32(file.crc); writer.u32(file.bytes.length); writer.u32(file.bytes.length); writer.u16(file.name.length);
    writer.u16(0); writer.u16(0); writer.u16(0); writer.u16(0); writer.u32(0); writer.u32(offsets[i]); writer.put(file.name);
  });
  const directoryLength = writer.offset - directoryOffset;
  writer.u32(0x06054b50); writer.u16(0); writer.u16(0); writer.u16(entries.length); writer.u16(entries.length);
  writer.u32(directoryLength); writer.u32(directoryOffset); writer.u16(0);
  if (writer.offset !== length) throw new Error('The ZIP writer produced an invalid length.');
  return new Blob([writer.bytes], { type: 'application/zip' });
}
function safeName(name) {
  return String(name || 'custom_npc').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'custom_npc';
}
async function previewSheet(compositions) {
  if (typeof document === 'undefined') return { reason: 'PNG rendering is unavailable in this environment.' };
  const visible = compositions.filter(c => c.frames.length && !c.empty);
  if (!visible.length) return { reason: 'This action group has no visible frames.' };
  const minX = Math.min(...visible.map(c => c.bounds.minX)), minY = Math.min(...visible.map(c => c.bounds.minY));
  const width = Math.max(...visible.map(c => c.bounds.minX + c.bounds.width)) - minX;
  const height = Math.max(...visible.map(c => c.bounds.minY + c.bounds.height)) - minY;
  const columns = Math.max(...visible.map(c => c.frames.length));
  if (width * columns > 8192 || height * 8 > 8192 || width * columns * height * 8 > 32000000) return { reason: 'The contact sheet exceeds the canvas size limit.' };
  const canvas = document.createElement('canvas'), frameCanvas = document.createElement('canvas');
  canvas.width = width * columns; canvas.height = height * 8;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  try {
    for (const source of visible) {
      const composition = { ...source, bounds: { minX, minY, width, height } };
      for (let f = 0; f < composition.frames.length; f++) {
        drawComposition(frameCanvas, composition, { frameIndex: f, scale: 1 });
        ctx.drawImage(frameCanvas, f * width, source.direction * height);
      }
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { reason: 'The browser could not create this PNG.' };
    return { bytes: new Uint8Array(await blob.arrayBuffer()), cellWidth: width, cellHeight: height, columns, rows: 8, origin: { x: -minX, y: -minY } };
  } finally { canvas.width = 1; canvas.height = 1; frameCanvas.width = 1; frameCanvas.height = 1; }
}

function groupManifest(groups, binary) {
  const exportedIndices = new Map(binary.compositions.map((composition, index) => [composition.actionIndex, index]));
  return groups.map(group => {
    const base = exportedIndices.get(group.base);
    const count = Math.min(8, binary.actions.length - base);
    const indices = Array.from({ length: count }, (_, direction) => base + direction);
    return {
      id: group.id, label: group.label, groupIndex: base / 8, base,
      sourceGroupIndex: group.index, sourceBase: group.base,
      sourceActionIndices: indices.map(index => binary.compositions[index].actionIndex),
      actionIndices: indices,
      directions: indices.filter(index => binary.actions[index].frames.length).map(index => index - base),
      emptyActionIndices: indices.filter(index => !binary.actions[index].frames.length),
    };
  });
}

function exportReadme(basename, manifest) {
  const groups = manifest.groups.map(group => `- ${group.label}: ACT ${group.actionIndices.join(', ')}`).join('\n');
  const warnings = manifest.warnings.length
    ? '\nMISSING PART ACTIONS\nThe following parts were omitted only from the listed actions; no pose was substituted.\n' + manifest.warnings.map(warning => `- ${warning}`).join('\n') + '\n'
    : '';
  return `NPC CHARACTER SPRITE EXPORT

${basename}: ${manifest.action === 'all' ? 'all' : 'selected'} job actions

The .spr and .act files share a basename and must stay together.
${manifest.actionLayout === 'compact'
    ? `Only the selected action groups are included in the ${manifest.actionCount} ACT slots, starting at ACT 0 in source order. Unselected groups are removed. A single selected action opens as the first action in Act Editor. Original source indices are recorded in the JSON.`
    : `All ${manifest.actionCount} original job ACT slots retain their original order. Empty source slots remain empty.`}
Each group uses the direction order: ${DIRECTIONS.join(', ')}.

ACTION GROUPS
${groups}

SPR 2.0 stores true-color images, including the selected hair and job palettes; no separate PAL files are needed. ACT 2.5 preserves composed layer offsets, mirroring, rotation, scale, tint and timing. Player sound events are removed.
Idle/sit head-look variants use the neutral look; accessories retain their neutral-look animation. Other actions follow the selected body's frame sequence.
Selected bird/cart companions are included in the artwork and metadata. Birds hover; carts roll during walking and idle during other poses. These are visual parts of this NPC, not separate followers, skills, or cart inventories.
${warnings}
INSTALLATION
Copy both files into your client sprite resource directory (or pack that path into your GRF), then register the sprite name and an unused view ID in the matching client identity/name tables and server configuration. Paths and IDs depend on your client/server version.
The package contains animation data. Which animations play in the game is controlled by the client and server. Registering this as a normal stationary NPC does not automatically make it walk, attack, or cast.

PREVIEWS
Optional PNG contact sheets are under previews/, one per action group. Direction rows are always in the order above; animation frames are columns. Missing directions remain blank. The JSON contains action indices, frame counts, timings, warnings and the reason for any omitted sheet. Omitted PNGs do not remove actions from the SPR/ACT pair.

No game data or server configuration was changed by this export.
`;
}

export async function exportNpc(parts, { name = 'custom_npc', metadata = {}, actionIds } = {}, onProgress = () => {}) {
  const selection = exportSelection(parts, actionIds);
  const basename = safeName(name), sourceIndices = [...selection.indices], compositions = [], totals = { frames: 0, layers: 0 };
  for (const actionIndex of sourceIndices) {
    if (compositions.length % 8 === 0) {
      onProgress(`Combining ${selection.all ? 'all' : 'selected'} job actions… ${compositions.length} / ${sourceIndices.length}`);
      await yieldUI();
    }
    collectComposition(parts, actionIndex, compositions, totals);
  }
  onProgress('Encoding the SPR/ACT pair…');
  await yieldUI();
  const binary = assembleBinary(parts, compositions);
  const manifest = {
    ...metadata,
    version: 3, name: basename, action: selection.all ? 'all' : 'selected', directionOrder: DIRECTIONS, actVersion: '2.5', sprVersion: '2.0', actionCount: binary.actions.length,
    actionLayout: selection.compact ? 'compact' : 'original',
    sourceActionCount: selection.count, sourceActionIndices: sourceIndices,
    excludedSourceActionIndices: Array.from({ length: selection.count }, (_, index) => index).filter(index => !selection.indices.has(index)),
    selectedActionCount: selection.indices.size,
    selectedActionIndices: binary.actions.map((_, index) => index),
    excludedActionIndices: [],
    groups: groupManifest(selection.groups, binary),
    frames: binary.actions.map(action => action.frames.length), delaysMs: binary.actions.map(action => action.delay),
    emptyActionIndices: binary.actions.flatMap((action, index) => action.frames.length ? [] : [index]),
    warnings: binary.warnings,
    parts: parts.map(part => ({ kind: part.kind, id: part.id, name: part.name, resource: part.resource, palette: part.palette ?? null })),
    spriteSheets: [],
  };
  const files = [{ name: `${basename}.spr`, bytes: binary.spr }, { name: `${basename}.act`, bytes: binary.act }];
  const encoder = new TextEncoder();
  // Reserve metadata, warning text, ZIP headers, and sheet descriptors before
  // adding optional PNGs. Native actions are never dropped to fit a preview.
  let available = ZIP_LIMIT - binary.spr.byteLength - binary.act.byteLength
    - encoder.encode(JSON.stringify(manifest)).length * 2 - encoder.encode(exportReadme(basename, manifest)).length - 1024 * 1024;
  for (const group of manifest.groups) {
    onProgress(`Creating preview sheet: ${group.label}…`);
    await yieldUI();
    let sheet;
    try {
      sheet = available > 0 ? await previewSheet(compositions.slice(group.base, group.base + 8)) : { reason: 'The preview budget for this ZIP has been reached.' };
    } catch (error) { sheet = { reason: `PNG rendering failed: ${error.message}` }; }
    if (!sheet.bytes || sheet.bytes.byteLength > available) {
      manifest.spriteSheets.push({ groupId: group.id, status: 'omitted', reason: sheet.reason || 'The preview budget for this ZIP has been reached.' });
      continue;
    }
    const file = `previews/${String(group.groupIndex).padStart(2, '0')}_${safeName(group.id)}.png`;
    files.push({ name: file, bytes: sheet.bytes }); available -= sheet.bytes.byteLength;
    manifest.spriteSheets.push({ groupId: group.id, status: 'included', file, cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight, columns: sheet.columns, rows: sheet.rows, origin: sheet.origin });
  }
  files.push({ name: `${basename}.json`, bytes: JSON.stringify(manifest, null, 2) }, { name: 'README.txt', bytes: exportReadme(basename, manifest) });
  onProgress('Packaging the download…');
  await yieldUI();
  const blob = createZip(files);
  return { blob, filename: `${basename}_${manifest.action}_actions.zip`, summary: {
    action: manifest.action, actionCount: manifest.actionCount, selectedActionCount: manifest.selectedActionCount, groupCount: manifest.groups.filter(group => group.directions.length).length,
    directions: 8, frames: manifest.frames, images: binary.imageCount, bytes: blob.size,
    hasSpriteSheet: manifest.spriteSheets.some(sheet => sheet.status === 'included'), warnings: manifest.warnings,
  } };
}
