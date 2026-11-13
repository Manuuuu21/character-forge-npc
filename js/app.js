import { openCharacterArchive, loadPair, resolveItemPair, closeCatalog } from './catalog.js';
import { createPart, composeCharacter, drawComposition, drawPartThumbnail, enumerateActions } from './sprite-engine.js';
import { exportNpc } from './export-npc.js';
import { availablePalettes, loadPalette, withPalette } from './palettes.js';
import { availableCompanions, supportsCompanion, companionMounted } from './companions.js';

const $ = id => document.getElementById(id);
const SLOTS = [
  ['top', 'Top headgear', 'T'], ['mid', 'Mid headgear', 'M'], ['lower', 'Lower headgear', 'L'],
  ['costumeTop', 'Costume top', 'CT'], ['costumeMid', 'Costume mid', 'CM'], ['costumeLower', 'Costume lower', 'CL'],
  ['garment', 'Garment', 'G'],
];
const DIRECTIONS = ['Front', 'Front left', 'Left', 'Back left', 'Back', 'Back right', 'Right', 'Front right'];
const PAGE_SIZE = 24;
const state = { catalog: null, job: null, head: null, gender: 'male', hairColor: '', jobColor: '', action: 'idle', direction: 0, zoom: 2,
  slot: 'top', loadout: {}, companions: { falcon: '', cart: '' }, page: 0, parts: [], actions: [], composition: null, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  frame: 0, lastFrame: 0, generation: 0, itemGeneration: 0, importing: false, exporting: false };
let pairCache = new Map();
let thumbnailObserver;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function say(message = '', error = false) {
  $('global-message').textContent = message;
  $('global-message').classList.toggle('error', error);
  $('global-message').hidden = !message;
}
function showPreviewMessage(message = '') {
  $('preview-message').textContent = message;
  $('preview-message').hidden = !message;
}
function progressText(value) {
  if (typeof value === 'string') return value;
  return value?.message || value?.label || value?.phase || 'Reading archive…';
}
function importProgress(value) {
  $('progress-label').textContent = progressText(value);
  const percent = typeof value === 'object' ? (value.percent ?? (value.total ? value.done / value.total * 100 : undefined)) : undefined;
  if (Number.isFinite(percent)) $('progress-bar').value = Math.min(100, Math.max(0, percent));
  else $('progress-bar').removeAttribute('value');
}

async function importFile(file) {
  if (!file || state.importing) return;
  $('import-error').hidden = true;
  if (!/\.(grf|gpf)$/i.test(file.name)) {
    $('import-error').textContent = 'Choose a Ragnarok GRF archive, such as data.grf.';
    $('import-error').hidden = false;
    return;
  }
  state.importing = true;
  $('choose-file').disabled = true;
  $('choose-file').textContent = 'Reading your archive…';
  $('import-progress').hidden = false;
  importProgress('Opening ' + file.name + '…');
  try {
    const catalog = await openCharacterArchive(file, { onProgress: importProgress });
    if (!catalog.jobs?.length) throw new Error('No usable character body ACT/SPR pairs were found. Choose your full client data.grf.');
    state.catalog = catalog;
    state.gender = catalog.jobs.some(job => job.genders?.male) ? 'male' : 'female';
    state.job = catalog.jobs.find(job => /^(novice|초보자)$/i.test(job.name) && job.genders?.[state.gender]) || catalog.jobs.find(job => job.genders?.[state.gender]);
    state.loadout = {};
    state.companions = { falcon: '', cart: '' };
    state.hairColor = ''; state.jobColor = '';
    state.action = 'idle';
    state.direction = 0;
    state.page = 0;
    state.slot = 'top';
    pairCache = new Map();
    $('archive-name').textContent = file.name;
    $('archive-name').title = file.name;
    $('job-search').value = '';
    $('item-search').value = '';
    $('direction').value = '0';
    $('import-screen').hidden = true;
    $('editor-screen').hidden = false;
    renderGenders(); renderJobs(); renderHeads(); renderLoadout(); renderTabs(); renderItems(); renderReport(file);
    await updatePreview();
    window.scrollTo({ top: 0 });
  } catch (error) {
    closeCatalog(state.catalog);
    state.catalog = null;
    state.generation++; state.itemGeneration++; state.parts = []; state.composition = null;
    thumbnailObserver?.disconnect();
    $('editor-screen').hidden = true; $('import-screen').hidden = false;
    $('import-error').textContent = error.message || 'The archive could not be read.';
    $('import-error').hidden = false;
  } finally {
    state.importing = false;
    $('choose-file').disabled = false;
    $('choose-file').textContent = 'Choose data.grf';
    $('import-progress').hidden = true;
    $('grf-file').value = '';
  }
}
function renderGenders() {
  document.querySelectorAll('[data-gender]').forEach(button => {
    const chosen = state.gender === button.dataset.gender;
    button.classList.toggle('selected', chosen);
    button.setAttribute('aria-pressed', chosen);
    button.disabled = !state.catalog.jobs.some(job => job.genders?.[button.dataset.gender]);
  });
}
function renderJobs() {
  const search = $('job-search').value.trim().toLowerCase();
  const jobs = state.catalog.jobs.filter(job => job.genders?.[state.gender] && `${job.name} ${job.id} ${job.resource}`.toLowerCase().includes(search));
  $('job-count').textContent = jobs.length;
  const list = $('job-list'); list.replaceChildren();
  if (!jobs.length) list.append(node('p', 'empty-state', 'No matching jobs.'));
  for (const job of jobs) {
    const button = node('button', 'job-option' + (job === state.job ? ' selected' : ''));
    button.type = 'button'; button.setAttribute('aria-pressed', job === state.job);
    button.title = `${job.name}\n${job.resource || ''}`;
    button.append(node('span', 'job-glyph', (job.name || '?').slice(0, 1)), node('span', 'job-label', job.name), node('small', '', String(job.jobId ?? '')));
    button.onclick = () => { state.job = job; pruneUnavailableEquipment(); renderJobs(); renderHeads(); renderTabs(); renderLoadout(); renderItems(); updatePreview(); };
    list.append(button);
  }
}
function renderHeads() {
  if (state.job.hasBuiltInHead) {
    $('head-select').replaceChildren(new Option('Built into job sprite', ''));
    $('head-select').disabled = true;
    return;
  }
  const heads = (state.catalog.heads || []).filter(head => head.genders?.[state.gender] && (!head.species || !state.job.species || head.species === state.job.species));
  if (!heads.includes(state.head)) state.head = heads.find(head => Number(head.id) === 1) || heads[0] || null;
  $('head-select').replaceChildren();
  if (!heads.length) $('head-select').append(new Option('No separate head in archive', ''));
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]; const option = new Option(head.name || `Style ${head.id}`, String(i));
    option.selected = head === state.head; $('head-select').append(option);
  }
  $('head-select').disabled = !heads.length;
  $('head-select').onchange = () => { state.head = heads[Number($('head-select').value)] || null; updatePreview(); };
}

function pairFor(record) {
  if (!record) return null;
  if (record.kind === 'falcon' || record.kind === 'cart') return record.pair;
  // Catalogs may carry robe ACT variants for each job; use the selected body resource.
  if (record.kind) return resolveItemPair(record, state.job, state.gender);
  return record.genders?.[state.gender] || null;
}
function colorOptions(kind) {
  return availablePalettes(state.catalog?.palettes, kind === 'head' ? visibleHead() : state.job, state.gender, kind);
}
function visibleHead() { return state.job?.hasBuiltInHead ? null : state.head; }
function selectedCompanion(kind) {
  return availableCompanions(state.catalog, state.job, kind).find(record => record.id === state.companions[kind]) || null;
}
function renderCompanions() {
  for (const kind of ['falcon', 'cart']) {
    const options = availableCompanions(state.catalog, state.job, kind);
    const eligible = supportsCompanion(state.job, kind);
    const select = $(kind + '-select');
    select.replaceChildren(new Option('None', ''));
    for (const record of options) select.append(new Option(record.name, record.id));
    select.value = selectedCompanion(kind)?.id || '';
    select.disabled = !options.length;
    $(kind + '-note').textContent = !eligible
      ? (kind === 'falcon' ? 'Hunter, Sniper, Ranger and Windhawk only.' : 'Available for jobs that use a cart.')
      : !options.length ? 'No matching companion sprites in this archive.'
      : kind === 'falcon' ? 'Uses this job’s bird sprite.' : `${options.length} cart types in this archive.`;
  }
}
function renderPalettes(parts = []) {
  for (const [kind, field, id] of [['head', 'hairColor', 'hair-color'], ['body', 'jobColor', 'job-color']]) {
    const record = kind === 'head' ? visibleHead() : state.job;
    const part = parts.find(part => part.kind === kind);
    const indexed = !part || part.spr.indexedCount > 0;
    const options = indexed ? colorOptions(kind) : [];
    if (!options.some(option => option.id === state[field])) state[field] = '';
    const select = $(id);
    select.replaceChildren(new Option('Original', ''));
    for (const palette of options) {
      const option = new Option(palette.label, palette.id);
      option.title = palette.path;
      select.append(option);
    }
    select.value = state[field];
    select.disabled = !record || !options.length;
    $(id + '-note').textContent = !record ? (state.job?.hasBuiltInHead ? 'Head is included in the job sprite.' : 'No separate hair sprite.') : !indexed ? 'This sprite uses fixed colors.' : options.length
      ? `${options.length} palette${options.length === 1 ? '' : 's'} in this archive`
      : 'No matching palettes in this archive.';
  }
}
async function parsed(record, kind) {
  const catalog = state.catalog;
  const paletteId = kind === 'body' ? state.jobColor : kind === 'head' ? state.hairColor : '';
  const paletteOption = paletteId ? colorOptions(kind).find(option => option.id === paletteId) : null;
  const pair = pairFor(record);
  if (!pair) throw new Error(`${record?.name || kind} has no ${state.gender} sprite for this job.`);
  let pending = pairCache.get(pair);
  if (!pending) {
    pending = loadPair(catalog, pair).then(bytes => createPart(bytes.spr, bytes.act));
    pairCache.set(pair, pending);
    if (pairCache.size > 64) pairCache.delete(pairCache.keys().next().value);
    pending.catch(() => pairCache.delete(pair));
  }
  const part = { ...await pending, kind, id: record.id, name: record.name, resource: record.resource, topLayer: !!record.topLayer,
    companionMounted: kind === 'body' && companionMounted(record) };
  if (!paletteOption || !part.spr.indexedCount) return part;
  try {
    return withPalette(part, await loadPalette(catalog, paletteOption), { id: paletteOption.id, color: paletteOption.color, path: paletteOption.path });
  } catch (error) { throw new Error(`${kind === 'head' ? 'Hair' : 'Job'} color: ${error.message} Select Original to use the sprite's built-in colors.`); }
}
function equipmentAllowed() { return !state.job?.hasBuiltInHead; }
function pruneUnavailableEquipment() {
  if (!equipmentAllowed()) return;
  for (const slot of Object.keys(state.loadout)) if (!pairFor(state.loadout[slot])) delete state.loadout[slot];
}
function visibleEquipment() {
  if (!equipmentAllowed()) return [];
  const entries = [];
  for (const [normal, costume] of [['top', 'costumeTop'], ['mid', 'costumeMid'], ['lower', 'costumeLower']]) {
    if (state.loadout[costume]) entries.push([costume, state.loadout[costume]]);
    else if (state.loadout[normal]) entries.push([normal, state.loadout[normal]]);
  }
  if (state.loadout.garment) entries.push(['garment', state.loadout.garment]);
  const seen = new Set();
  return entries.filter(([, item]) => {
    const key = `${item.kind}:${item.viewId ?? item.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
async function updatePreview() {
  const generation = ++state.generation;
  renderPalettes();
  renderCompanions();
  state.composition = null; state.parts = []; state.actions = []; state.frame = 0;
  $('action-select').disabled = true;
  $('export-button').disabled = true;
  $('sprite-canvas').hidden = true;
  showPreviewMessage('Loading character sprites…');
  say();
  try {
    const requests = [parsed(state.job, 'body')];
    if (visibleHead()) requests.push(parsed(visibleHead(), 'head'));
    for (const [slot, item] of visibleEquipment()) requests.push(parsed(item, slot));
    for (const kind of ['falcon', 'cart']) {
      const companion = selectedCompanion(kind);
      if (companion) requests.push(parsed(companion, kind));
    }
    const parts = await Promise.all(requests);
    if (generation !== state.generation || !state.catalog) return;
    state.parts = parts;
    renderPalettes(parts);
    state.actions = enumerateActions(parts);
    renderActions();
    renderComposition();
  } catch (error) {
    if (generation !== state.generation) return;
    showPreviewMessage(error.message || 'This character could not be rendered.');
    say('The selected sprite could not be loaded. Try another job or remove the affected equipment. ' + error.message, true);
  }
}
function selectedAction() { return state.actions.find(action => action.id === state.action); }
function renderActions() {
  const available = state.actions.filter(action => action.directions.length);
  if (!available.some(action => action.id === state.action)) state.action = available[0]?.id || 'idle';
  $('action-select').replaceChildren();
  for (const action of available) {
    const option = new Option(action.label, action.id);
    option.selected = action.id === state.action;
    if (action.warnings?.length) option.title = 'Some equipped pieces are unavailable in this action.';
    $('action-select').append(option);
  }
  $('action-select').disabled = !available.length;
  renderDirections();
}
function renderDirections() {
  const directions = selectedAction()?.directions || [];
  if (!directions.includes(state.direction)) state.direction = directions[0] ?? 0;
  for (const option of $('direction').options) option.disabled = !directions.includes(Number(option.value));
  $('direction').value = String(state.direction);
  $('direction').disabled = !directions.length;
  $('rotate-left').disabled = directions.length < 2;
  $('rotate-right').disabled = directions.length < 2;
}
function renderComposition() {
  state.composition = null;
  $('export-button').disabled = true;
  try {
    const composition = composeCharacter(state.parts, { action: state.action, direction: state.direction });
    state.composition = composition; state.frame = 0; state.lastFrame = performance.now();
    const label = selectedAction()?.label || state.action;
    $('character-name').textContent = state.job.name;
    $('character-details').textContent = `${state.gender === 'male' ? 'Male' : 'Female'} · ${label} · ${DIRECTIONS[state.direction]}`;
    $('pose-caption').textContent = label.toUpperCase();
    $('sprite-canvas').setAttribute('aria-label', `${state.job.name}, ${state.gender}, ${label}, facing ${DIRECTIONS[state.direction]}`);
    $('sprite-canvas').hidden = false;
    showPreviewMessage();
    say(composition.warnings?.length ? composition.warnings.join(' ') : '');
    drawFrame();
    $('export-button').disabled = false;
  } catch (error) {
    state.composition = null;
    $('sprite-canvas').hidden = true;
    showPreviewMessage(error.message || 'This pose is unavailable.');
  }
  updatePlaybackButton();
}
function drawFrame() {
  if (!state.composition) return;
  drawComposition($('sprite-canvas'), state.composition, { frameIndex: state.frame, scale: state.zoom });
  $('zoom-value').textContent = `${state.zoom}×`;
  $('frame-info').textContent = `Frame ${state.frame + 1} / ${state.composition.frames.length}`;
}
function animationLoop(now) {
  requestAnimationFrame(animationLoop);
  if (!document.hidden && state.composition && state.playing && !state.exporting && !state.importing) {
    const delay = Math.max(1, state.composition.delay || 150);
    if (now - state.lastFrame >= delay) {
      state.frame = (state.frame + Math.max(1, Math.floor((now - state.lastFrame) / delay))) % state.composition.frames.length;
      state.lastFrame = now;
      try { drawFrame(); } catch (error) { state.composition = null; $('export-button').disabled = true; showPreviewMessage(error.message); }
    }
  }
}
function updatePlaybackButton() {
  $('play-toggle').replaceChildren(document.createTextNode(state.playing ? 'Ⅱ ' : '▷ '), node('span', '', state.playing ? 'Pause' : 'Play'));
  $('play-toggle').setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
}

function renderTabs() {
  $('slot-tabs').replaceChildren();
  for (const [id, label] of SLOTS) {
    const button = node('button', 'slot-tab' + (state.slot === id ? ' selected' : ''), label);
    button.setAttribute('aria-pressed', state.slot === id);
    button.disabled = !equipmentAllowed();
    button.onclick = () => { state.slot = id; state.page = 0; renderTabs(); renderItems(); };
    $('slot-tabs').append(button);
  }
}
function renderLoadout() {
  const allowed = equipmentAllowed();
  $('loadout-list').replaceChildren();
  for (const [slot, label, short] of SLOTS) {
    const item = allowed ? state.loadout[slot] : null;
    const row = node('div', 'loadout-row' + (item ? ' equipped' : ''));
    const text = node('button', 'loadout-text');
    text.append(node('strong', '', label), node('span', '', !allowed ? 'Unavailable for this job' : item ? item.name : 'Nothing equipped'));
    text.disabled = !allowed;
    text.title = item ? item.name : label;
    text.onclick = () => { state.slot = slot; state.page = 0; renderTabs(); renderItems(); };
    row.append(node('span', 'slot-indicator', short), text);
    if (item) {
      const remove = node('button', 'remove-item', '×');
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.onclick = () => { delete state.loadout[slot]; renderLoadout(); renderItems(); updatePreview(); };
      row.append(remove);
    }
    $('loadout-list').append(row);
  }
  $('clear-loadout').disabled = !allowed || !Object.keys(state.loadout).length;
  $('loadout-hint').textContent = allowed ? 'Costume pieces replace their matching headgear in the preview.'
    : 'This job does not display equipment. Your selections return when you switch to a job that supports it.';
}
function slotMatches(item) {
  if (state.slot === 'garment') return item.kind === 'garment';
  if (item.kind !== 'headgear') return false;
  if (item.costume === true && !state.slot.startsWith('costume')) return false;
  if (item.costume === false && state.slot.startsWith('costume')) return false;
  // Client GRFs commonly omit server equip masks. Unclassified items stay available for manual placement.
  if (!item.slots?.length) return true;
  return item.slots.includes(state.slot) || item.slots.includes(state.slot.replace(/^costume/, '').toLowerCase()) || item.slots.includes('unknown');
}
function renderItems() {
  if (!state.catalog) return;
  const generation = ++state.itemGeneration;
  thumbnailObserver?.disconnect();
  const allowed = equipmentAllowed();
  $('item-search').disabled = !allowed;
  if (!allowed) {
    state.page = 0;
    $('item-count').textContent = 'Equipment disabled';
    $('slot-help').textContent = 'This job does not display equipped items';
    $('page-info').textContent = 'Unavailable for this job';
    $('previous-page').disabled = true;
    $('next-page').disabled = true;
    $('item-grid').replaceChildren(node('div', 'empty-state', 'Werewolf and Wereraptor do not display equipment. Choose another job to select items.'));
    return;
  }
  const search = $('item-search').value.trim().toLowerCase();
  const all = state.catalog.items.filter(item => slotMatches(item) && pairFor(item) && `${item.name} ${item.id ?? ''} ${item.viewId ?? ''} ${item.resource ?? ''}`.toLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  $('item-count').textContent = `${all.length.toLocaleString()} ${all.length === 1 ? 'piece' : 'pieces'}`;
  $('slot-help').textContent = all.some(item => item.slotKnown === false || !item.slots?.length || item.slots.includes('unknown')) && state.slot !== 'garment' ? 'Unclassified pieces can be placed manually' : 'Select a piece to equip it';
  $('page-info').textContent = `Page ${state.page + 1} of ${pages.toLocaleString()}`;
  $('previous-page').disabled = state.page === 0;
  $('next-page').disabled = state.page >= pages - 1;
  const grid = $('item-grid'); grid.replaceChildren();
  if (!all.length) grid.append(node('div', 'empty-state', 'No matching pieces for this character. Try another search, slot or gender.'));
  const queue = []; let running = 0;
  async function pump() {
    if (generation !== state.itemGeneration) return;
    while (running < 2 && queue.length) {
      const { item, art } = queue.shift(); running++;
      (async () => {
        try {
          const part = await parsed(item, item.kind);
          if (generation !== state.itemGeneration) return;
          const canvas = node('canvas'); canvas.setAttribute('aria-hidden', 'true');
          drawPartThumbnail(canvas, part, { size: 64 }); art.replaceChildren(canvas);
        } catch { art.title = 'Preview unavailable. Select this item to see the detailed error.'; art.replaceChildren(node('span', 'item-placeholder', '—')); }
        finally { running--; pump(); }
      })();
    }
  }
  const artItems = new Map();
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      thumbnailObserver.unobserve(entry.target);
      queue.push({ item: artItems.get(entry.target), art: entry.target });
    }
    pump();
  }, { rootMargin: '100px' });
  for (const item of all.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const selected = state.loadout[state.slot] === item;
    const card = node('button', 'item-card' + (selected ? ' selected' : ''));
    card.setAttribute('aria-pressed', selected);
    const idLabel = Number.isFinite(item.id) ? `ID ${item.id}` : `View ${item.viewId ?? '—'}`;
    card.title = `${item.name}\n${idLabel} · View ${item.viewId ?? '—'}`;
    const art = node('span', 'item-art'); art.append(node('span', 'item-placeholder', '✦'));
    const label = node('span', 'item-label'); label.append(node('strong', '', item.name), node('small', '', idLabel));
    card.append(art, label);
    card.onclick = () => {
      if (!equipmentAllowed()) return;
      if (state.loadout[state.slot] === item) delete state.loadout[state.slot];
      else state.loadout[state.slot] = item;
      renderLoadout(); renderItems(); updatePreview();
    };
    grid.append(card); artItems.set(art, item); thumbnailObserver.observe(art);
  }
}
function renderReport(file) {
  const content = $('report-content'); content.replaceChildren();
  content.append(node('p', '', `${file.name} · ${(file.size / 1024 ** 3).toFixed(2)} GB · ${state.catalog.jobs.length} jobs · ${state.catalog.heads?.length || 0} hairstyles · ${state.catalog.items.length.toLocaleString()} equipment entries · ${(state.catalog.palettes?.count || 0).toLocaleString()} color palettes.`));
  content.append(node('p', '', 'The archive stays on this device and is read as needed. Reloading the page requires selecting it again. Items without a known equip position can be placed in a headgear slot manually. Item IDs and view IDs are different; both can be searched when the archive supplies their mapping.'));
  const problems = state.catalog.problems || [];
  if (problems.length) {
    const list = node('ul');
    for (const problem of problems.slice(0, 100)) list.append(node('li', '', typeof problem === 'string' ? problem : problem.message || JSON.stringify(problem)));
    if (problems.length > 100) list.append(node('li', '', `${problems.length - 100} additional notes omitted.`));
    content.append(list);
  }
}

function changeDirection(value) {
  if (!selectedAction()?.directions.includes(value)) return;
  state.direction = value; $('direction').value = String(value);
  if (state.parts.length) renderComposition();
}
function rotateDirection(step) {
  const directions = selectedAction()?.directions || [];
  if (!directions.length) return;
  const index = directions.indexOf(state.direction);
  changeDirection(directions[(index + step + directions.length) % directions.length]);
}
function changeZoom(delta) {
  const previous = state.zoom;
  state.zoom = Math.min(8, Math.max(1, state.zoom + delta));
  try { drawFrame(); } catch (error) { state.zoom = previous; drawFrame(); say(error.message, true); }
}
function selectedExportActions() {
  const checked = new Set([...$('export-action-list').querySelectorAll('input:checked')].map(input => input.value));
  return state.actions.filter(action => action.directions.length && checked.has(action.id));
}
function updateExportSelection() {
  const available = state.actions.filter(action => action.directions.length);
  const selected = selectedExportActions();
  const allSelected = selected.length === available.length && selected.length > 0;
  $('export-action-count').textContent = allSelected
    ? `All ${available.length} job actions selected`
    : `${selected.length} of ${available.length} job actions selected`;
  $('select-all-actions').disabled = allSelected || !available.length;
  $('unselect-all-actions').disabled = !selected.length;
  $('export-selection-hint').hidden = selected.length > 0;
  $('download-export').disabled = state.exporting || !selected.length;
  $('export-submit-label').textContent = allSelected ? 'Export all actions' : 'Export selected actions';
  const warnings = [...new Set(selected.flatMap(action => action.warnings || []))];
  $('export-warnings').hidden = !warnings.length;
  $('export-warning-summary').textContent = `Missing equipment actions (${warnings.length})`;
  $('export-warning-list').replaceChildren(...warnings.slice(0, 80).map(warning => node('li', '', warning)));
  if (warnings.length > 80) $('export-warning-list').append(node('li', '', `${warnings.length - 80} more notes will be included in the export metadata.`));
}
function selectAllExportActions(checked) {
  for (const input of $('export-action-list').querySelectorAll('input')) input.checked = checked;
  $('export-status').hidden = true;
  updateExportSelection();
}
function openExport() {
  if (!state.parts.length || !state.composition) return;
  $('export-name').value = `${state.job.name}_${state.gender}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 54) || 'my_npc';
  const available = state.actions.filter(action => action.directions.length);
  $('export-action-list').replaceChildren(...available.map(action => {
    const label = node('label');
    const input = node('input');
    input.type = 'checkbox'; input.name = 'export-actions'; input.value = action.id; input.checked = true;
    label.append(input, node('span', '', action.label));
    return label;
  }));
  $('export-warnings').open = false;
  $('export-status').hidden = true;
  updateExportSelection();
  $('export-dialog').showModal();
}
async function downloadExport(event) {
  event.preventDefault();
  if (state.exporting || !state.parts.length) return;
  const actionIds = selectedExportActions().map(action => action.id);
  if (!actionIds.length) { updateExportSelection(); return; }
  state.exporting = true;
  $('download-export').disabled = true; $('close-export').disabled = true;
  $('export-name').disabled = true;
  $('export-action-selection').disabled = true;
  $('export-status').hidden = false;
  $('export-status').textContent = 'Preparing your NPC…';
  try {
    const result = await exportNpc(state.parts, { name: $('export-name').value, actionIds, metadata: {
      archive: $('archive-name').textContent, job: state.job.name, jobId: state.job.jobId, jobResource: state.job.resource, gender: state.gender,
      hairstyle: visibleHead()?.id ?? null,
      hairColor: state.parts.find(part => part.kind === 'head')?.palette ?? null,
      jobColor: state.parts.find(part => part.kind === 'body')?.palette ?? null,
      equipment: Object.fromEntries((equipmentAllowed() ? Object.entries(state.loadout) : []).map(([slot, item]) => [slot, { id: item.id, viewId: item.viewId, name: item.name }])),
      companions: Object.fromEntries(state.parts.filter(part => part.kind === 'falcon' || part.kind === 'cart')
        .map(part => [part.kind, { id: part.id, name: part.name, resource: part.resource }])),
    } }, value => { $('export-status').textContent = progressText(value); });
    const url = URL.createObjectURL(result.blob);
    const link = node('a'); link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $('export-status').textContent = `Ready! ${result.filename} was sent to your downloads with ${actionIds.length} selected job action${actionIds.length === 1 ? '' : 's'} (${result.summary.selectedActionCount ?? result.summary.actionCount} directional actions).`;
    const warningCount = result.summary.warnings?.length || 0;
    say(`Exported ${result.filename} with ${actionIds.length} selected job action${actionIds.length === 1 ? '' : 's'}.${warningCount ? ' Review the included notes for unavailable equipment actions and omitted preview sheets.' : ''}`);
  } catch (error) { $('export-status').textContent = 'Export failed: ' + error.message; }
  finally {
    state.exporting = false;
    $('close-export').disabled = false; $('export-name').disabled = false; $('export-action-selection').disabled = false;
    updateExportSelection();
  }
}

$('choose-file').onclick = () => $('grf-file').click();
$('grf-file').onchange = () => importFile($('grf-file').files[0]);
for (const type of ['dragenter', 'dragover']) $('drop-zone').addEventListener(type, event => { event.preventDefault(); if (!state.importing) $('drop-zone').classList.add('dragover'); });
$('drop-zone').addEventListener('dragleave', event => { if (!$('drop-zone').contains(event.relatedTarget)) $('drop-zone').classList.remove('dragover'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); if (event.dataTransfer.files.length !== 1) { $('import-error').textContent = 'Please select one data.grf archive at a time.'; $('import-error').hidden = false; return; } importFile(event.dataTransfer.files[0]); });
// Prevent the browser from navigating away when a file is dropped outside the target.
window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
$('change-archive').onclick = () => {
  state.generation++; state.itemGeneration++; thumbnailObserver?.disconnect();
  closeCatalog(state.catalog); state.catalog = null; state.parts = []; state.actions = []; state.composition = null; pairCache = new Map();
  state.job = null; state.head = null; state.loadout = {};
  state.companions = { falcon: '', cart: '' };
  $('editor-screen').hidden = true; $('import-screen').hidden = false; $('import-error').hidden = true;
  window.scrollTo({ top: 0 }); $('choose-file').focus();
};
$('job-search').oninput = renderJobs;
$('hair-color').onchange = () => { state.hairColor = $('hair-color').value; updatePreview(); };
$('job-color').onchange = () => { state.jobColor = $('job-color').value; updatePreview(); };
for (const kind of ['falcon', 'cart']) $(kind + '-select').onchange = () => {
  if (!supportsCompanion(state.job, kind)) return;
  state.companions[kind] = $(kind + '-select').value;
  updatePreview();
};
$('item-search').oninput = () => { state.page = 0; renderItems(); };
document.querySelectorAll('[data-gender]').forEach(button => button.onclick = () => {
  state.gender = button.dataset.gender;
  if (!state.job.genders?.[state.gender]) state.job = state.catalog.jobs.find(job => job.genders?.[state.gender]);
  pruneUnavailableEquipment();
  renderGenders(); renderJobs(); renderHeads(); renderTabs(); renderItems(); renderLoadout(); updatePreview();
});
$('action-select').onchange = () => {
  state.action = $('action-select').value;
  renderDirections();
  renderComposition();
};
$('direction').onchange = () => changeDirection(Number($('direction').value));
$('rotate-left').onclick = () => rotateDirection(-1);
$('rotate-right').onclick = () => rotateDirection(1);
$('zoom-out').onclick = () => changeZoom(-1); $('zoom-in').onclick = () => changeZoom(1);
$('play-toggle').onclick = () => { state.playing = !state.playing; state.lastFrame = performance.now(); updatePlaybackButton(); };
$('grid-toggle').onchange = () => $('preview-stage').classList.toggle('no-grid', !$('grid-toggle').checked);
$('clear-loadout').onclick = () => { state.loadout = {}; renderLoadout(); renderItems(); updatePreview(); };
$('previous-page').onclick = () => { state.page--; renderItems(); };
$('next-page').onclick = () => { state.page++; renderItems(); };
$('export-button').onclick = openExport;
$('select-all-actions').onclick = () => selectAllExportActions(true);
$('unselect-all-actions').onclick = () => selectAllExportActions(false);
$('export-action-list').onchange = () => { $('export-status').hidden = true; updateExportSelection(); };
$('close-export').onclick = () => $('export-dialog').close();
$('export-dialog').addEventListener('cancel', event => { if (state.exporting) event.preventDefault(); });
$('export-form').onsubmit = downloadExport;
requestAnimationFrame(animationLoop);
