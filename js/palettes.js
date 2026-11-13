import { readGrfEntry } from './grf.js';
import { legacyLuaText } from './lua-legacy.js';

// GRF filenames may be decoded as Windows-1252 or Korean. Match both without
// changing the archive entry used to read the bytes.
const key = value => legacyLuaText(String(value)).replaceAll('\\', '/').normalize('NFC').toLowerCase();
const sexes = new Map([['남', 'male'], ['여', 'female']].map(([sex, gender]) => [key(sex), gender]));
const folders = [
  ['data/palette/몸/', 'body', 'human'],
  ['data/palette/머리/', 'head', 'human'],
  ['data/palette/도람족/body/', 'body', 'doram'],
  ['data/palette/도람족/몸/', 'body', 'doram'],
  ['data/palette/도람족/머리/', 'head', 'doram'],
].map(([prefix, kind, species]) => ({ prefix: key(prefix), kind, species }));
const hairPrefix = key('머리');
const lookupKey = (species, gender, resource) => `${species}|${gender}|${key(resource)}`;

// These client sprite names have different, established palette filenames.
// Other resources match exactly; an unrelated job's colors are never offered.
const bodyAliases = new Map([
  ['summoner', '묘족'], ['cart_summoner', '묘족'],
  ['산타', 'santa'], ['여름', 'summer'], ['여름2', 'summer2'],
].map(([resource, palette]) => [key(resource), key(palette)]));

export function indexPalettes(entries, archive = null) {
  const index = { body: new Map(), head: new Map(), count: 0, counts: { body: 0, head: 0 } };
  const seen = new Set();
  for (const entry of entries) {
    const path = key(entry.path);
    if (!path.endsWith('.pal') || seen.has(path) || (entry.size !== undefined && entry.size !== 1024)) continue;
    const folder = folders.find(candidate => path.startsWith(candidate.prefix));
    if (!folder) continue;
    const relative = path.slice(folder.prefix.length, -4), slash = relative.lastIndexOf('/');
    const directory = slash < 0 ? '' : relative.slice(0, slash + 1);
    const fields = relative.slice(slash + 1).split('_');
    const sexIndex = fields.findLastIndex(field => sexes.has(field));
    // Transformed bodies such as werewolf share genderless PAL files. Some
    // riding forms put their resource suffix before the color, after gender.
    const colorIndex = sexIndex >= 1 ? fields.findIndex((field, i) => i > sexIndex && /^\d+$/.test(field))
      : folder.kind === 'body' && /^\d+$/.test(fields.at(-1)) ? fields.length - 1 : -1;
    if (colorIndex < 1) continue;
    const color = Number(fields[colorIndex]);
    if (!Number.isSafeInteger(color)) continue;
    const gender = sexIndex >= 1 ? sexes.get(fields[sexIndex]) : 'any';
    // A costume suffix follows the color in PAL and the gender in SPR:
    // costume_1/arch_mage_남_3_1.pal -> costume_1/arch_mage_1.
    let resource = fields.filter((_, i) => i !== sexIndex && i !== colorIndex).join('_');
    if (folder.kind === 'head' && resource.startsWith(hairPrefix)) resource = resource.slice(hairPrefix.length);
    resource = directory + resource;
    const mapKey = lookupKey(folder.species, gender, resource), map = index[folder.kind];
    if (!map.has(mapKey)) map.set(mapKey, []);
    map.get(mapKey).push({ id: path, color, label: `Color ${color}`, path: entry.path, entry, archive });
    seen.add(path); index.count++; index.counts[folder.kind]++;
  }
  for (const kind of ['body', 'head']) for (const options of index[kind].values()) {
    options.sort((a, b) => a.color - b.color || a.id.localeCompare(b.id));
  }
  return index;
}

export function availablePalettes(index, record, gender, kind = 'body') {
  if (!index?.[kind] || !record || !['male', 'female'].includes(gender)) return [];
  const species = record.species || 'human';
  const resource = key(record.resource || '');
  const relative = (record.variant ? key(record.variant) + '/' : '') + resource;
  const optionsFor = relativeResource => {
    const exact = index[kind].get(lookupKey(species, gender, relativeResource)) || [];
    const shared = index[kind].get(lookupKey(species, 'any', relativeResource)) || [];
    if (!shared.length) return exact;
    const colors = new Set(exact.map(option => option.color));
    return [...exact, ...shared.filter(option => !colors.has(option.color))].sort((a, b) => a.color - b.color);
  };
  const exact = optionsFor(relative);
  if (exact?.length) return exact;
  if (kind !== 'body') return [];
  // Keep costume directories and suffixes when applying the client aliases.
  const suffix = record.variant ? /(_\d+)$/.exec(resource)?.[1] || '' : '';
  const basename = suffix ? resource.slice(0, -suffix.length) : resource;
  const alias = bodyAliases.get(basename);
  if (!alias) return [];
  return optionsFor((record.variant ? key(record.variant) + '/' : '') + alias + suffix);
}

export function parsePalette(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  if (!bytes || bytes.byteLength !== 1024) throw new Error('A Ragnarok palette must contain exactly 256 colors (1024 bytes).');
  // PAL uses RGB plus a reserved byte. Transparency is determined by sprite
  // index zero, not by the reserved bytes (which are often all zero).
  return bytes.slice();
}

export async function loadPalette(catalog, option) {
  if (!option?.entry) throw new Error('This color palette is unavailable.');
  const archive = option.archive || catalog.archive;
  const cache = catalog.paletteCache ||= new Map();
  if (!cache.has(option.entry)) {
    const promise = readGrfEntry(archive, option.entry).then(parsePalette);
    cache.set(option.entry, promise);
    promise.catch(() => cache.delete(option.entry));
    if (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  return cache.get(option.entry);
}

export function withPalette(part, palette, metadata = {}) {
  if (!palette) return part;
  if (!part?.spr?.indexedCount) throw new Error('This sprite uses true-color images and cannot use an indexed color palette.');
  // New part identity invalidates the renderer's WeakMap cache while leaving
  // cached source parts, other characters, and the original colors intact.
  return { ...part, palette: { ...metadata }, spr: { ...part.spr, palette: parsePalette(palette) } };
}
