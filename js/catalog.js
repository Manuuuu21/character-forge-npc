import { openGrf, readGrfEntry } from './grf.js';
import { legacyLuaText } from './lua-legacy.js';
import { parseLuaTable } from './lua.js';
import { readAccessoryTable } from './accessory-tables.js';
import { readGarmentTables } from './garment-tables.js';
import { readLiteralLub } from './literal-lub.js';
import { indexPalettes } from './palettes.js';
import { indexCompanions } from './companions.js';

const key = value => legacyLuaText(String(value)).replaceAll('\\', '/').normalize('NFC').toLowerCase();
const western = new TextDecoder('windows-1252');
const byteMap = new Map(Array.from({length:256},(_,i)=>[western.decode(Uint8Array.of(i)),i]));
export function displayText(value) {
  const text = String(value ?? '');
  if (!/[^\x00-\x7f]/.test(text) || /\p{Script=Hangul}/u.test(text)) return text;
  if ([...text].some(c=>!byteMap.has(c))) return text;
  const bytes = Uint8Array.from(text,c=>byteMap.get(c));
  for (const encoding of ['utf-8','euc-kr']) { try { return new TextDecoder(encoding,{fatal:true}).decode(bytes); } catch {} }
  return text;
}
function sourceText(bytes) { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { return western.decode(bytes); } }
const bodyNames = {
  '초보자':['Novice',0], '검사':['Swordman',1], '마법사':['Mage',2], '궁수':['Archer',3], '성직자':['Acolyte',4], '상인':['Merchant',5], '도둑':['Thief',6],
  '기사':['Knight',7], '프리스트':['Priest',8], '위저드':['Wizard',9], '제철공':['Blacksmith',10], '헌터':['Hunter',11], '어세신':['Assassin',12],
  '크루세이더':['Crusader',14], '몽크':['Monk',15], '세이지':['Sage',16], '로그':['Rogue',17], '연금술사':['Alchemist',18], '바드':['Bard',19], '무희':['Dancer',20],
  '슈퍼노비스':['Super Novice',23], '건너':['Gunslinger',24], '닌자':['Ninja',25], '결혼':['Wedding',22], '산타':['Santa',26], '여름':['Summer',27],
  '로드나이트':['Lord Knight',4008], '하이프리':['High Priest',4009], '하이위저드':['High Wizard',4010], '화이트스미스':['Whitesmith',4011], '스나이퍼':['Sniper',4012], '어쌔신크로스':['Assassin Cross',4013],
  '팔라딘':['Paladin',4015], '챔피온':['Champion',4016], '프로페서':['Professor',4017], '스토커':['Stalker',4018], '크리에이터':['Creator',4019], '클로운':['Clown',4020], '집시':['Gypsy',4021],
  '룬나이트':['Rune Knight',4054], '워록':['Warlock',4055], '레인져':['Ranger',4056], '아크비숍':['Arch Bishop',4057], '미케닉':['Mechanic',4058], '길로틴크로스':['Guillotine Cross',4059],
  '로얄가드':['Royal Guard',4066], '소서러':['Sorcerer',4067], '민스트럴':['Minstrel',4068], '원더러':['Wanderer',4069], '슈라':['Sura',4070], '제네릭':['Genetic',4071], '쉐도우체이서':['Shadow Chaser',4072],
  '태권':['Taekwon',4046], '권성':['Star Gladiator',4047], '소울링커':['Soul Linker',4049], '운영자':['Game Master',null], '운영자2':['Game Master 2',null],
};
function jobLabel(resource) {
  const text=displayText(resource); if(bodyNames[text]) return bodyNames[text];
  if(text.endsWith('_h') && bodyNames[text.slice(0,-2)]) return [`${bodyNames[text.slice(0,-2)][0]} High`,null];
  const title=text.replaceAll('_',' ').replace(/\b[a-z]/g,c=>c.toUpperCase()); return [title,null];
}
function selectEntry(path) {
  return /^data\/sprite\//i.test(path) && /\.(act|spr)$/i.test(path)
    || /^data\/palette\//i.test(path) && /\.pal$/i.test(path)
    || /\/(?:accessoryid|accname|spriterobeid|spriterobename|iteminfo|jobidentity|pcjobname)\.(?:lua|lub)$/i.test(path)
    || /\/idnum2item(?:displayname|resname|desc)table\.txt$/i.test(path)
    || /^data\/texture\//i.test(path) && /\/item\/[^/]+\.(bmp|png)$/i.test(path) ? {} : null;
}
function tableEntry(archive,name) {
  return archive.entries.filter(e=>new RegExp(`/${name}\\.(?:lub|lua)$`,'i').test(e.path))
    .sort((a,b)=>Number(/\/datainfo\//i.test(b.path))-Number(/\/datainfo\//i.test(a.path)) || Number(/\.lub$/i.test(b.path))-Number(/\.lub$/i.test(a.path)))[0];
}
function descriptionSlots(description,kind) {
  if(kind==='garment') return ['garment'];
  const line=description.replace(/\^[0-9a-f]{6}/gi,'').split('\n').find(line=>/(?:위치|position|location)\s*:/i.test(line));
  if(!line) return ['top','mid','lower'];
  const slots=[]; if(/상|upper|top/i.test(line))slots.push('top'); if(/중|mid/i.test(line))slots.push('mid'); if(/하|low/i.test(line))slots.push('lower');
  return slots.length?slots:['top','mid','lower'];
}
function spritePair(entries,base,sprBase=base) {
  const act=entries.get(key(base+'.act')),spr=entries.get(key(sprBase+'.spr'));return act&&spr?{act,spr,path:base}:null;
}
const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));

export async function openCharacterArchive(file,{encoding='windows-1252',onProgress=()=>{}}={}) {
  onProgress('Reading the GRF file table…'); await yieldUI();
  const archive=await openGrf(file,encoding,selectEntry), problems=[...archive.problems];
  const entries=new Map(archive.entries.map(e=>[key(e.path),e]));
  const jobMap=new Map(),headMap=new Map(),equipment=new Map();
  onProgress('Finding character bodies and hairstyles…'); await yieldUI();
  for(const entry of archive.entries) {
    if(!/\.act$/i.test(entry.path))continue;
    const path=displayText(entry.path), match=path.match(/^data\/sprite\/([^/]+)\/(몸통|머리통)\/(남|여)\/(.+)\.act$/i);
    if(!match)continue;
    const [,race,part,sex,relative]=match,gender=sex==='남'?'male':'female';
    const resource=relative.replace(new RegExp(`_${sex}(?=_|$)`),'');
    const id=`${race}/${resource}`,base=entry.path.replace(/\.act$/i,'');
    const pair=spritePair(entries,base); if(!pair)continue;
    const map=part==='몸통'?jobMap:headMap;
    const basename=resource.split('/').pop(),[name,jobId]=jobLabel(basename);
    const variant=resource.includes('/')?resource.split('/')[0]:null;
    let record=map.get(id); if(!record){record={id,name:part==='몸통'?name+(variant?` · ${variant.replaceAll('_',' ')}`:''):`Style ${basename}`,jobId,resource:basename,variant,species:race==='도람족'?'doram':'human',genders:{}};map.set(id,record);}
    // These transformations contain their own complete head in the body SPR.
    record.hasBuiltInHead=part==='몸통'&&/^(?:werewolf|wereraptor)[23]?$/i.test(basename);
    record.genders[gender]=pair;
  }
  const jobs=[...jobMap.values()].sort((a,b)=>Number(b.jobId===0)-Number(a.jobId===0)||Number(!!a.variant)-Number(!!b.variant)||a.name.localeCompare(b.name,undefined,{numeric:true}));
  const heads=[...headMap.values()].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  if(!jobs.length)throw new Error('This GRF has no complete character body ACT/SPR pairs. Choose your full data.grf.');
  const globals=new Map();
  onProgress('Reading headgear and garment mappings…'); await yieldUI();
  for(const [name,global] of [['accessoryid','ACCESSORY_IDs'],['accname','AccNameTable']]) {
    try { const entry=tableEntry(archive,name); if(!entry)throw new Error(`${name}.lub is missing.`); readAccessoryTable(await readGrfEntry(archive,entry),global,globals); }
    catch(error){problems.push(`Headgear mapping: ${error.message}`);}
  }
  const accessoryPrefix='data/sprite/악세사리/';
  for(const [viewId,resource] of globals.get('AccNameTable')||[]) {
    if(!Number.isSafeInteger(viewId)||viewId<=0||typeof resource!=='string')continue;
    const genders={};for(const [gender,sex]of [['male','남'],['female','여']]){const pair=spritePair(entries,`${accessoryPrefix}${sex}/${sex}${resource}`);if(pair)genders[gender]=pair;}
    if(Object.keys(genders).length)equipment.set(`headgear:${viewId}`,{viewId,kind:'headgear',resource,genders,topLayer:false});
  }
  const robeGlobals=new Map();
  for(const name of ['spriterobeid','spriterobename']) {
    try { const entry=tableEntry(archive,name);if(!entry)throw new Error(`${name}.lub is missing.`);readGarmentTables(await readGrfEntry(archive,entry),robeGlobals); }
    catch(error){problems.push(`Garment mapping: ${error.message}`);}
  }
  const robeGroups=new Map(),robePrefix=key('data/sprite/로브/');
  for(const entry of archive.entries){if(!/\.act$/i.test(entry.path))continue;const raw=legacyLuaText(entry.path);if(!key(raw).startsWith(robePrefix))continue;const parts=raw.slice(robePrefix.length).split('/');const groupKey=key(parts.shift());if(!robeGroups.has(groupKey))robeGroups.set(groupKey,[]);robeGroups.get(groupKey).push({entry,relative:displayText(parts.join('/'))});}
  const topLayers=new Set(robeGlobals.get('RobeTopLayer')?.values());
  for(const [viewId,resource]of robeGlobals.get('RobeNameTable')||[]) {
    if(!Number.isSafeInteger(viewId)||viewId<=0||!resource)continue;
    const genders={},jobPairs=new Map();
    for(const candidate of new Set([resource,robeGlobals.get('RobeNameTable_Eng')?.get(viewId)].filter(Boolean))) {
      for(const {entry,relative} of robeGroups.get(key(candidate))||[]){
        const match=relative.match(/^(남|여)\/(.+)\.act$/);if(!match)continue;
        const gender=match[1]==='남'?'male':'female',jobResource=match[2].replace(new RegExp(`_${match[1]}$`),'');
        const base=entry.path.replace(/\.act$/i,'');const pair=spritePair(entries,base)||spritePair(entries,base,`data/sprite/로브/${candidate}/${candidate}`);if(!pair)continue;
        if(!jobPairs.has(jobResource))jobPairs.set(jobResource,{});jobPairs.get(jobResource)[gender]=pair;
        if(jobResource==='초보자'||!genders[gender])genders[gender]=pair;
      }
    }
    if(Object.keys(genders).length)equipment.set(`garment:${viewId}`,{viewId,kind:'garment',resource,genders,jobPairs,topLayer:topLayers.has(viewId)});
  }
  // Still permit archives without mapping tables: raw accessories remain selectable by resource name.
  if(![...equipment.values()].some(e=>e.kind==='headgear')) {
    const raw=new Map();for(const entry of archive.entries){const path=displayText(entry.path),m=path.match(/^data\/sprite\/악세사리\/(남|여)\/\1(.+)\.act$/);if(!m)continue;
      const pair=spritePair(entries,entry.path.replace(/\.act$/i,''));if(!pair)continue;const resource=m[2];if(!raw.has(resource))raw.set(resource,{viewId:null,kind:'headgear',resource,genders:{},topLayer:false});raw.get(resource).genders[m[1]==='남'?'male':'female']=pair;
    }for(const[resource,item]of raw)equipment.set(`raw:${resource}`,item);
  }
  onProgress('Reading item names, IDs and equipment positions…'); await yieldUI();
  let itemInfo=new Map();
  try {const entry=tableEntry(archive,'iteminfo');if(entry){const bytes=await readGrfEntry(archive,entry);itemInfo=bytes[0]===27?readLiteralLub(bytes,{target:'tbl'}):new Map(Object.entries(parseLuaTable(sourceText(bytes)).items).map(([id,value])=>[Number(id),new Map(Object.entries(value))]));}}
  catch(error){problems.push(`Item names: ${error.message} Resources can still be searched by view ID and filename.`);}
  const icons=new Map();for(const entry of archive.entries)if(/\/item\/[^/]+\.(bmp|png)$/i.test(entry.path))icons.set(key(entry.path.split('/').pop().replace(/\.(bmp|png)$/i,'')),entry);
  const items=[],used=new Set();
  for(const [id,info]of itemInfo){if(!(info instanceof Map))continue;const viewId=Number(info.get('ClassNum'));if(!viewId)continue;
    const name=displayText(info.get('identifiedDisplayName')||info.get('unidentifiedDisplayName')||`Item ${id}`).replaceAll('_',' ');
    const rawDescription=info.get('identifiedDescriptionName'),description=displayText(rawDescription instanceof Map?[...rawDescription.values()].join('\n'):Array.isArray(rawDescription)?rawDescription.join('\n'):String(rawDescription||''));
    const plainDescription=description.replace(/\^[0-9a-f]{6}/gi,'');
    const equipmentLines=plainDescription.split('\n').filter(line=>/(?:계열|위치|type|category|position|location)\s*:/i.test(line)).join('\n');
    const garment=/걸칠\s*것|garment/i.test(equipmentLines);
    let base=equipment.get(`${garment?'garment':'headgear'}:${viewId}`);if(!base)continue;
    const location=plainDescription.split('\n').find(line=>/(?:위치|position|location)\s*:/i.test(line))||'';
    const headgear=/상|중|하|upper|mid|low|head/i.test(location)||/(?:계열|type|category)\s*:\s*(?:투구|머리|의상|headgear|costume)/i.test(plainDescription);
    const infoResource=info.get('identifiedResourceName')||info.get('unidentifiedResourceName')||'';
    const sameResource=key(infoResource).replace(/^_+/,'')===key(base.resource).replace(/^_+/,'');
    if(!garment&&!headgear&&!sameResource)continue;
    const costume=/의상|costume/i.test(name+'\n'+description.split('\n').filter(line=>/계열|type|category/i.test(line)).join('\n'));
    const slots=descriptionSlots(description,base.kind);const resource=info.get('identifiedResourceName')||info.get('unidentifiedResourceName')||base.resource;
    items.push({...base,id:Number(id),name,costume,slots,slotKnown:base.kind==='garment'||!!location,description,icon:icons.get(key(resource))||icons.get(key(resource).replace(/^_+/,''))||null});used.add(`${base.kind}:${viewId}`);
  }
  for(const [mapKey,base]of equipment){if(used.has(mapKey))continue;items.push({...base,id:`view-${base.kind}-${base.viewId??base.resource}`,name:displayText(base.resource).replaceAll('_',' ').trim(),costume:null,slots:base.kind==='garment'?['garment']:['top','mid','lower'],slotKnown:base.kind==='garment',description:'No itemInfo record is available for this sprite. Search or equip it by resource name or view ID. Choose its equipment position manually.',icon:icons.get(key(base.resource))||icons.get(key(base.resource).replace(/^_+/,''))||null});}
  items.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  const palettes=indexPalettes(archive.entries,archive);
  const companions=indexCompanions(archive.entries);
  const stats={entries:archive.count,jobs:jobs.length,heads:heads.length,items:items.length,palettes:palettes.count,falcons:companions.falcons.length,carts:companions.carts.length,headgears:items.filter(i=>i.kind==='headgear').length,garments:items.filter(i=>i.kind==='garment').length,version:archive.version===0x300?'3.0':'2.0'};
  onProgress(`Ready: ${jobs.length} jobs and ${items.length} equipment sprites.`);
  return {archive,jobs,heads,items,palettes,companions,problems,stats,pairCache:new Map(),paletteCache:new Map(),iconCache:new Map(),urls:new Set()};
}

export async function loadPair(catalog,pair) {
  if(!pair?.act||!pair?.spr)throw new Error('This sprite is unavailable for the selected character.');
  const cacheKey=pair.act.path+'|'+pair.spr.path;
  if(!catalog.pairCache.has(cacheKey)){
    const promise=Promise.all([readGrfEntry(catalog.archive,pair.act),readGrfEntry(catalog.archive,pair.spr)]).then(([act,spr])=>({act,spr}));
    catalog.pairCache.set(cacheKey,promise);promise.catch(()=>catalog.pairCache.delete(cacheKey));
    if(catalog.pairCache.size>24)catalog.pairCache.delete(catalog.pairCache.keys().next().value);
  }
  return catalog.pairCache.get(cacheKey);
}
export function resolveItemPair(item,job,gender) {
  if(item.kind==='garment'&&item.jobPairs?.size)return item.jobPairs.get(job?.resource)?.[gender]||null;
  return item.genders[gender]||null;
}
export async function getIconUrl(catalog,item) {
  if(!item.icon||catalog.disposed)return null;
  if(!catalog.iconCache.has(item.icon.path))catalog.iconCache.set(item.icon.path,readGrfEntry(catalog.archive,item.icon).then(bytes=>{if(catalog.disposed)return null;const url=URL.createObjectURL(new Blob([bytes],{type:/\.png$/i.test(item.icon.path)?'image/png':'image/bmp'}));catalog.urls.add(url);return url;}).catch(()=>null));
  return catalog.iconCache.get(item.icon.path);
}
export function closeCatalog(catalog) {if(!catalog)return;catalog.disposed=true;for(const url of catalog.urls)URL.revokeObjectURL(url);catalog.urls.clear();catalog.pairCache.clear();catalog.paletteCache?.clear();catalog.iconCache.clear();}
