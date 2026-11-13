import { composeCharacter, rgbaImage, drawComposition, DIRECTIONS } from './sprite-engine.js';

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

// Each source can have its own 256-color palette. Convert referenced images to
// native true-color SPR images so no quantization or palette merging loses color.
export function buildNpcBinary(parts, { action = 'idle' } = {}) {
  const compositions = Array.from({ length: 8 }, (_, direction) => composeCharacter(parts, { action, direction }));
  const images = [], remaps = parts.map(() => new Map());
  let pixels = 0, layerCount = 0;
  const actions = compositions.map(composition => ({
    delay: composition.delay,
    frames: composition.frames.map(frame => composition.order.flatMap(partIndex => frame[partIndex].flatMap(layer => {
      if (layer.index < 0 || !layer.color[3]) return [];
      if (++layerCount > 500000) throw new Error('The selected animation has too many layers to export.');
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
  act.put(new Uint8Array([65, 67, 5, 2])); act.u16(8); act.skip(10);
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
  return { spr: spr.bytes, act: act.bytes, actions, compositions, imageCount: images.length };
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
  if (length > 128 * 1024 * 1024) throw new Error('The export archive exceeds 128 MB.');
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
  if (typeof document === 'undefined') return null;
  const minX = Math.min(...compositions.map(c => c.bounds.minX)), minY = Math.min(...compositions.map(c => c.bounds.minY));
  const width = Math.max(...compositions.map(c => c.bounds.minX + c.bounds.width)) - minX;
  const height = Math.max(...compositions.map(c => c.bounds.minY + c.bounds.height)) - minY;
  const columns = Math.max(...compositions.map(c => c.frames.length));
  if (width * columns > 8192 || height * 8 > 8192 || width * columns * height * 8 > 32000000) return null;
  const canvas = document.createElement('canvas'), frameCanvas = document.createElement('canvas');
  canvas.width = width * columns; canvas.height = height * 8;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  for (let d = 0; d < 8; d++) {
    const composition = { ...compositions[d], bounds: { minX, minY, width, height } };
    for (let f = 0; f < composition.frames.length; f++) {
      drawComposition(frameCanvas, composition, { frameIndex: f, scale: 1 });
      ctx.drawImage(frameCanvas, f * width, d * height);
    }
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not create the PNG preview.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), cellWidth: width, cellHeight: height, columns, rows: 8, origin: { x: -minX, y: -minY } };
}
export async function exportNpc(parts, { action = 'idle', name = 'custom_npc', metadata = {} } = {}, onProgress = () => {}) {
  const basename = safeName(name);
  onProgress('Combining the eight directions…');
  await new Promise(resolve => setTimeout(resolve, 0));
  const binary = buildNpcBinary(parts, { action });
  onProgress('Creating the sprite sheet…');
  const sheet = await previewSheet(binary.compositions);
  const manifest = {
    ...metadata,
    version: 1, name: basename, action, directionOrder: DIRECTIONS, actVersion: '2.5', sprVersion: '2.0', actionCount: 8,
    frames: binary.actions.map(direction => direction.frames.length), delaysMs: binary.actions.map(direction => direction.delay),
    parts: parts.map(part => ({ kind: part.kind, id: part.id, name: part.name, resource: part.resource })),
    spriteSheet: sheet ? { file: `${basename}.png`, cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight, columns: sheet.columns, rows: sheet.rows, origin: sheet.origin } : null,
  };
  const readme = `NPC CHARACTER SPRITE EXPORT\n\n${basename}: ${action}\n\nThe .spr and .act files share a basename and must stay together.\nOnly the selected ${action} pose is exported. Its eight facing directions occupy ACT actions 0–7, the NPC idle action group.\nDirections: ${DIRECTIONS.join(', ')}.\nSPR 2.0 stores true-color images; ACT 2.5 preserves layer offsets, mirroring, rotation, scale, tint and timing. Player sound events are removed.\nIdle/sit head-look variants use the neutral look; accessories retain their neutral-look animation.\n\nTo use the NPC, copy both files into your client data/sprite/npc directory (or pack that path into your GRF), then register the sprite name and an unused NPC view ID in your client's NPC identity/name tables and your server's NPC configuration. IDs and installation paths depend on your client/server version.\n\n${sheet ? 'The PNG is a transparent contact sheet: directions in rows, frames in columns. Frame counts and timings are in the JSON file.' : 'The contact sheet was omitted because its dimensions exceed the safe PNG size limit. All frames remain in the ACT/SPR pair.'}\n\nNo game data or server configuration was changed by this export.\n`;
  const files = [{ name: `${basename}.spr`, bytes: binary.spr }, { name: `${basename}.act`, bytes: binary.act },
    { name: `${basename}.json`, bytes: JSON.stringify(manifest, null, 2) }, { name: 'README.txt', bytes: readme }];
  if (sheet) files.push({ name: `${basename}.png`, bytes: sheet.bytes });
  onProgress('Packaging the download…');
  const blob = createZip(files);
  return { blob, filename: `${basename}_${action}.zip`, summary: { action, directions: 8, frames: manifest.frames, images: binary.imageCount, bytes: blob.size, hasSpriteSheet: Boolean(sheet) } };
}
