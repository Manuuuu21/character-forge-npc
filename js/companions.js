import { legacyLuaText } from './lua-legacy.js';

const key = value => legacyLuaText(String(value ?? '').normalize('NFC')).replaceAll('\\', '/').toLowerCase();
const effectPath = 'data/sprite/이팩트/';

// Client mappings: roBrowserLegacy DBManager.getBodyPath/getCartPath and
// Entity.setCart. These are resources in the user's archive, never bundled art.
const birds = [
  { id: 'falcon:hunter', name: 'Falcon', resource: '매', family: 'hunter' },
  { id: 'falcon:sniper', name: 'Sniper falcon', resource: '매2', family: 'sniper' },
  { id: 'falcon:ranger', name: 'Ranger owl', resource: 'owl', family: 'ranger' },
  { id: 'falcon:windhawk', name: 'Windhawk hawk', resource: 'windhawk_hawk', family: 'windhawk' },
];
const carts = [
  ['슈노손수레', 'Super Novice cart'],
  ['손수레', 'Cart type 1'], ['손수레1', 'Cart type 2'],
  ['손수레2', 'Cart type 3'], ['손수레3', 'Cart type 4'],
  ['손수레4', 'Cart type 5'], ['손수레5', 'Cart type 6'],
  ['손수레6', 'Cart type 7'], ['손수레7', 'Cart type 8'],
  ['손수레8', 'Cart type 9'], ['선물상자카트', 'Gift box cart'],
  ['포링싣은카트', 'Poring cargo cart'], ['포링카트', 'Poring cart'],
  ['마도카트', 'Mado cart'],
].map(([resource, name], type) => ({ id: `cart:${type}`, name, resource, type }));

const jobs = new Map();
function register(resources, family, mounted = false) {
  for (const resource of resources) jobs.set(key(resource), { family, mounted });
}
register(['헌터'], 'hunter');
register(['스나이퍼'], 'sniper');
register(['레인져'], 'ranger');
register(['windhawk'], 'windhawk');
// The client explicitly maps both Windhawk mounts to its hawk. Ranger's
// warg form has no falcon mapping and must not fall back to Hunter's falcon.
register(['windhawk_riding', 'wolf_windhawk'], 'windhawk', true);
register(['상인', '제철공', '화이트스미스', '연금술사', '크리에이터', '미케닉', '제네릭', 'meister', 'biolo'], 'merchant');
register(['상인멧돼지', '제철공멧돼지', '화이트스미스멧돼지', '연금술사멧돼지', '크리에이터멧돼지', '미케닉멧돼지', '제네릭멧돼지', '마도기어', 'meister_riding', 'meister_madogear1', 'meister_madogear2', 'biolo_riding'], 'merchant', true);
register(['슈퍼노비스', 'hyper_novice'], 'supernovice');
register(['슈퍼노비스포링', 'hyper_novice_riding'], 'supernovice', true);

function jobProfile(job) {
  if (!job || job.species && job.species !== 'human' || job.hasBuiltInHead) return null;
  let resource = String(job.resource ?? '').normalize('NFC');
  // Costume folders carry a matching suffix; do not strip arbitrary digits
  // from unrelated job names or accept partial name matches.
  if (/^costume_\d+$/i.test(job.variant ?? '')) resource = resource.replace(/_\d+$/, '');
  resource = resource.replace(/_(?:h|b)$/i, '');
  return jobs.get(key(resource)) ?? null;
}

export function companionMounted(job) {
  return jobProfile(job)?.mounted ?? false;
}

export function supportsCompanion(job, kind) {
  const profile = jobProfile(job);
  if (!profile) return false;
  if (kind === 'cart') return profile.family === 'merchant' || profile.family === 'supernovice';
  return kind === 'falcon' && birds.some(bird => bird.family === profile.family);
}

export function indexCompanions(entries = []) {
  const files = new Map(entries.map(entry => [key(entry.path), entry]));
  function completePair(record, kind) {
    const path = effectPath + record.resource;
    const act = files.get(key(path + '.act')), spr = files.get(key(path + '.spr'));
    return act && spr ? { ...record, kind, pair: { act, spr, path } } : null;
  }
  return {
    falcons: birds.map(record => completePair(record, 'falcon')).filter(Boolean),
    carts: carts.map(record => completePair(record, 'cart')).filter(Boolean),
  };
}

export function availableCompanions(catalog, job, kind) {
  if (!supportsCompanion(job, kind)) return [];
  const profile = jobProfile(job);
  if (kind === 'falcon') return (catalog?.companions?.falcons ?? []).filter(bird => bird.family === profile.family);
  // Super/Hyper Novice use their own cart; regular merchants use types 1–13.
  return (catalog?.companions?.carts ?? []).filter(cart => profile.family === 'supernovice' ? cart.type === 0 : cart.type !== 0);
}
