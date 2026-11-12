// The page: the header (rigs, tuner, input, volume, power), the library
// (rigs and components) and the rack, one unit per slot in chain order with
// the spine, the signal's cable, down its left edge.

import { Board, SRC_LIVE, SRC_DEMO, SRC_FILE } from './audio.ts';
import { PluginBoard, inPlugin } from './plugin.ts';
import type { WorkletStats } from './worklet/protocol.ts';
import {
  PARAM_BY_ID, MODULES, CATEGORIES, NSLOTS, M_GLOW, M_RASP, M_FUZZ, M_MUFF, M_BOOST, M_TRANSPARENT, M_METAL, isAmp, M_OCTAVE, M_CABIR, M_NAM, RIGS, RIG_TAGS, NOT_IN_RIG,
  defaults, rigValues, diffValues, fromNorm, toNorm, slotTypeId, slotOnId, slotKnobId, type ParamValues, type Rig,
} from './dsp/params.ts';
import { STAGE_STRIDE } from './dsp/engine.ts';
import { insertUnit, removeUnit, moveUnit, units, pack, changes, toRig, type Perm } from './rack.ts';
import { treat, COMPLAINTS, type Complaint } from './doctor.ts';
import { hintFor } from './ui/hints.ts';
import { makeControl, type Control } from './ui/controls.ts';
import { Spine } from './ui/spine.ts';
import { ModuleViz, type VizLive } from './ui/viz.ts';
import { Stage } from './ui/stage.ts';
import { encodeShare, parseAny, codeInHash, decodeShare, shareLink, downloadRig } from './share.ts';
import { loadState, saveState, loadUserRigs, saveUserRigs, cleanValues, type UserRig } from './settings.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- state ----------------------------------------------------------------

// In the plugin's WebView the host owns the audio; the page is just the editor.
const plugin = inPlugin() ? new PluginBoard() : null;
const board: Board | PluginBoard = plugin ?? new Board();
document.documentElement.classList.toggle('in-plugin', !!plugin);
let values: ParamValues = defaults();
let rigName = RIGS[0].name, rigTag = RIGS[0].tag;
let edited = false;
let userRigs: UserRig[] = loadUserRigs();
let source = 'demo:0', device = '', channel = 2;
let tunerMute = false;
/** Folded units, by slot; travels with a unit when the rack is rearranged. */
let folded: boolean[] = new Array(NSLOTS).fill(false);
const globals = new Map<string, Control>();

interface UnitView { slot: number; type: number; el: HTMLElement; viz: ModuleViz; lvl: HTMLElement; controls: Control[] }
let views: UnitView[] = [];

interface Listed { name: string; tag: string; values: () => ParamValues }
const allRigs = (): Listed[] => [
  ...RIGS.map((r) => ({ name: r.name, tag: r.tag, values: () => rigValues(r) })),
  ...userRigs.map((u) => ({ name: u.name, tag: 'mine', values: () => ({ ...defaults(), ...u.values }) as ParamValues })),
];

const TAG_COLOURS: Record<string, string> = { clean: '#9cc3dd', crunch: '#ffb04a', lead: '#ff7a45', heavy: '#ff5a5a', fuzz: '#ff8fd0', ambient: '#b99bff', mine: '#7dff9a' };
const tagColour = (t: string) => TAG_COLOURS[t] ?? '#ffb04a';
const typeOf = (slot: number) => Math.round(values[slotTypeId(slot)]);
const isOn = (slot: number) => values[slotOnId(slot)] >= 0.5;
const drives = (type: number) => type === M_GLOW || type === M_RASP || type === M_FUZZ || type === M_MUFF || type === M_BOOST || type === M_TRANSPARENT || type === M_METAL || type === M_OCTAVE || isAmp(type);
const narrow = () => window.matchMedia('(max-width: 900px)').matches;

// ---- the tone doctor ------------------------------------------------------------

let doctorBefore: ParamValues | null = null;

function doctor(c: Complaint): void {
  const r = treat(values, c);
  if (!r.moved.length) { toast('nothing left to turn for that on this rig'); return; }
  doctorBefore = values;
  $('doctor-undo').removeAttribute('disabled');
  commit(r.values, Array.from({ length: NSLOTS }, (_, i) => i));
  toast(`${COMPLAINTS.find((x) => x.id === c)!.label}: moved ${r.moved.join(', ')}`);
}

/** The footer explains the knob under the pointer (or the focus) in plain words. */
function wireHints(): void {
  const bar = $('knob-hint'), keys = $('keys-hint');
  const show = (e: Event) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('.knob, .knob-wrap, [data-hint]');
    const text = k?.dataset.hint;
    if (!k || !text) return;
    const name = k.querySelector('.label')?.textContent ?? '';
    bar.textContent = '';
    const b = document.createElement('b'); b.textContent = name.toLowerCase();
    bar.append(b, ` — ${text}`);
    bar.hidden = false; keys.hidden = true;
  };
  const hide = () => { bar.hidden = true; keys.hidden = false; };
  for (const id of ['units', 'in-gain', 'heat']) {
    const n = $(id);
    n.addEventListener('mouseover', show); n.addEventListener('focusin', show);
    n.addEventListener('mouseout', hide); n.addEventListener('focusout', hide);
  }
}

function wireDoctor(): void {
  const pop = $('doctor-pop'), btn = $('doctor-btn'), grid = $('doctor-grid');
  for (const c of COMPLAINTS) {
    const b = button('chip', c.label, c.hint, () => doctor(c.id));
    grid.append(b);
  }
  const place = () => {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 288, r.right - 280))}px`;
  };
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    place(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => { if (!pop.hidden && !(e.target as HTMLElement).closest('#doctor-pop, #doctor-btn')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  $('doctor-undo').addEventListener('click', () => {
    if (!doctorBefore) return;
    commit(doctorBefore, Array.from({ length: NSLOTS }, (_, i) => i));
    doctorBefore = null;
    $('doctor-undo').setAttribute('disabled', '');
    toast('put it back');
  });
}

function persist(): void {
  if (plugin) return;   // the session keeps it
  saveState({ rig: rigName, values: cleanValues(values) as ParamValues, volume: values.volume, iface: values.iface, source: source === 'file' ? 'demo:0' : source, device, channel });
}

let toastTimer = 0;
function toast(msg: string, ms = 3500): void {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
}

function markEdited(e: boolean): void {
  edited = e;
  $('browse').classList.toggle('edited', e);
  // the session keeps the name; a leading * marks it edited
  plugin?.setCurrent(e ? `*${rigName}` : rigName);
}

function storeUserRigs(): void {
  if (plugin) plugin.saveUser(userRigs.map((r) => ({ name: r.name, values: r.values })));
  else saveUserRigs(userRigs);
}

/** One parameter, from a control. */
function setValue(id: string, v: number, fromUser = true): void {
  values[id] = v;
  board.setParam(id, v);
  globals.get(id)?.set(v);
  if (fromUser && !NOT_IN_RIG.includes(id)) markEdited(true);
  persist();
}

/** A new arrangement of the rack (add, remove, move): send what changed and redraw. */
function commit(next: ParamValues, perm: Perm, focus?: { slot: number; sel: string }): void {
  board.setParams(changes(values, next));
  values = next;
  folded = perm.map((old) => (old >= 0 ? folded[old] : false));
  renderRack();
  markEdited(true);
  persist();
  if (focus) views.find((v) => v.slot === focus.slot)?.el.querySelector<HTMLElement>(focus.sel)?.focus();
}

// ---- the rack -----------------------------------------------------------------

function button(cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text; b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function buildUnit(slot: number, pos: number, count: number): UnitView {
  const type = typeOf(slot), def = MODULES[type];
  const el = document.createElement('section');
  el.className = 'unit';
  el.dataset.slot = String(slot);
  el.dataset.cat = def.cat;
  el.style.setProperty('--accent', def.accent);
  el.setAttribute('aria-label', `${pos + 1}: ${def.name}`);

  const head = document.createElement('div');
  head.className = 'unit-head';
  const lamp = button('lamp', '', '', () => toggle(slot));
  const grip = document.createElement('span');
  grip.className = 'grip'; grip.textContent = '⠿'; grip.title = 'drag to move'; grip.draggable = true;
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/x-ft-slot', String(slot));
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setDragImage(el, 24, 20); }
    el.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => { el.classList.remove('dragging'); hideDrop(); });
  const num = document.createElement('span'); num.className = 'num'; num.textContent = String(pos + 1).padStart(2, '0');
  const name = document.createElement('h3'); name.textContent = def.name;
  const blurb = document.createElement('small'); blurb.textContent = def.blurb;
  const lvl = document.createElement('span'); lvl.className = 'lvl'; lvl.append(document.createElement('i'));
  const tools = document.createElement('span'); tools.className = 'tools';
  const move = (to: number, sel: string) => { const r = moveUnit(values, slot, to); commit(r.values, r.perm, { slot: to, sel }); };
  const up = button('tool up', '▲', `move the ${def.name} earlier`, () => move(pos - 1, '.up'));
  const down = button('tool down', '▼', `move the ${def.name} later`, () => move(pos + 1, '.down'));
  up.disabled = pos === 0; down.disabled = pos === count - 1;
  const fold = button('tool fold', '', '', () => { folded[slot] = !folded[slot]; refreshUnit(view); });
  const remove = button('tool remove', '×', `take the ${def.name} out of the rack`, () => { const r = removeUnit(values, slot); commit(r.values, r.perm); });
  tools.append(up, down, fold, remove);
  head.append(lamp, grip, num, name, blurb, lvl, tools);
  head.addEventListener('dblclick', (e) => { if ((e.target as HTMLElement).closest('button')) return; folded[slot] = !folded[slot]; refreshUnit(view); });

  const body = document.createElement('div');
  body.className = 'unit-body';
  const canvas = document.createElement('canvas');
  canvas.className = 'viz';
  const knobs = document.createElement('div');
  knobs.className = 'knobs';
  const controls = def.knobs.map((kd, k) => {
    const id = slotKnobId(slot, k);
    const big = isAmp(type) && (kd.id === 'gain' || kd.id === 'master');
    const c = makeControl(kd, fromNorm(kd, values[id]), (real) => setValue(id, toNorm(kd, real)), { size: big ? 52 : 44, segLimit: 4 });
    c.el.dataset.hint = hintFor(def.id, kd.id);
    knobs.append(c.el);
    return c;
  });
  body.append(canvas, knobs);
  if (type === M_CABIR) body.append(filePicker('ir'));
  if (type === M_NAM) body.append(filePicker('nam'));
  el.append(head, body);
  if (isAmp(type)) el.classList.add('wide');
  const view: UnitView = { slot, type, el, viz: new ModuleViz(canvas, type), lvl: lvl.firstChild as HTMLElement, controls };
  refreshUnit(view);
  return view;
}

const loaded = { ir: '', nam: '' };
const pickLabel = { ir: 'load IR…', nam: 'load capture…' };
function setLoaded(kind: 'ir' | 'nam', name: string): void {
  loaded[kind] = name;
  for (const b of document.querySelectorAll<HTMLElement>(`.file-pick[data-kind="${kind}"] .chip`)) b.textContent = name ? `${kind === 'ir' ? 'IR' : 'NAM'}: ${name}` : pickLabel[kind];
}
/** "load…" on the cab IR and NAM units. The IR is a WAV in the browser too; the plugin opens its own chooser for both. */
function filePicker(kind: 'ir' | 'nam'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'file-pick'; wrap.dataset.kind = kind;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'chip'; btn.textContent = loaded[kind] ? `${kind === 'ir' ? 'IR' : 'NAM'}: ${loaded[kind]}` : pickLabel[kind];
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'audio/*,.wav'; input.hidden = true;
  btn.addEventListener('click', () => { if (plugin) { if (kind === 'ir') plugin.pickIR(); else plugin.pickNAM(); } else input.click(); });
  input.addEventListener('change', async () => {
    const f = input.files?.[0]; if (!f) return;
    try { await (board as Board).loadIR(f); setLoaded('ir', f.name.replace(/\.[^.]+$/, '')); }
    catch (err) { toast(err instanceof Error ? err.message : 'could not load that file'); }
    input.value = '';
  });
  wrap.append(btn, input);
  return wrap;
}

function refreshUnit(v: UnitView): void {
  const on = isOn(v.slot), def = MODULES[v.type];
  v.el.classList.toggle('off', !on);
  v.el.classList.toggle('folded', folded[v.slot]);
  const lamp = v.el.querySelector('.lamp') as HTMLButtonElement;
  lamp.setAttribute('aria-pressed', String(on));
  lamp.title = `switch the ${def.name} ${on ? 'off' : 'on'} (${v.el.querySelector('.num')?.textContent?.replace(/^0/, '')})`;
  lamp.setAttribute('aria-label', lamp.title);
  const fold = v.el.querySelector('.fold') as HTMLButtonElement;
  fold.textContent = folded[v.slot] ? '+' : '−';
  fold.title = folded[v.slot] ? `open the ${def.name}` : `fold the ${def.name} away`;
  fold.setAttribute('aria-label', fold.title);
  fold.setAttribute('aria-expanded', String(!folded[v.slot]));
}

function renderRack(): void {
  const host = $('units');
  host.textContent = '';
  const slots = units(values);
  views = slots.map((s, pos) => buildUnit(s, pos, slots.length));
  for (const v of views) host.append(v.el);
  if (slots.length < NSLOTS) {
    const empty = document.createElement('button');
    empty.type = 'button'; empty.className = 'empty-slot';
    empty.innerHTML = slots.length === 0
      ? '<b>the rack is empty</b><span>drag components here from the library, or pick a rig</span>'
      : `<b>+</b><span>drop a component here · ${NSLOTS - slots.length} free</span>`;
    empty.addEventListener('click', () => openLibrary('parts'));
    host.append(empty);
  }
  $('rack-count').textContent = `${slots.length} / ${NSLOTS}`;
}

function toggle(slot: number): void {
  setValue(slotOnId(slot), isOn(slot) ? 0 : 1);
  const v = views.find((x) => x.slot === slot);
  if (v) refreshUnit(v);
}

function addModule(type: number, at?: number): void {
  const r = insertUnit(values, type, at);
  if (!r) { toast(`the rack is full (${NSLOTS} units): take one out first`); return; }
  commit(r.values, r.perm);
  const v = views.find((x) => x.slot === r.slot);
  if (v) { v.el.classList.add('enter'); v.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// ---- dragging into and around the rack ------------------------------------------

const DT_SLOT = 'text/x-ft-slot', DT_MODULE = 'text/x-ft-module';

/** The chain position a drop at clientY lands on, and where to draw the line. */
function dropAt(clientY: number): { index: number; y: number } {
  const body = $('rack-body').getBoundingClientRect();
  for (let i = 0; i < views.length; i++) {
    const r = views[i].el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { index: i, y: r.top - body.top - 5 };
  }
  const last = views[views.length - 1]?.el.getBoundingClientRect();
  return { index: views.length, y: last ? last.bottom - body.top + 4 : 0 };
}

function hideDrop(): void { $('drop-line').hidden = true; }

function wireDrops(): void {
  const body = $('rack-body'), line = $('drop-line');
  body.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes(DT_SLOT) && !types.includes(DT_MODULE)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = types.includes(DT_SLOT) ? 'move' : 'copy';
    const { y } = dropAt(e.clientY);
    line.hidden = false;
    line.style.top = `${y}px`;
  });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget as Node)) hideDrop(); });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    hideDrop();
    const { index } = dropAt(e.clientY);
    const slot = e.dataTransfer?.getData(DT_SLOT), mod = e.dataTransfer?.getData(DT_MODULE);
    if (slot) {
      const from = Number(slot), fromPos = views.findIndex((v) => v.slot === from);
      const to = index > fromPos ? index - 1 : index;
      if (fromPos >= 0 && to !== fromPos) { const r = moveUnit(values, from, to); commit(r.values, r.perm); }
    } else if (mod) addModule(Number(mod), index);
  });
}

// ---- rigs ----------------------------------------------------------------------

function loadRig(rig: Listed): void {
  const p = pack({ ...rig.values(), volume: values.volume, iface: values.iface });
  values = p.values;
  folded = new Array(NSLOTS).fill(false);
  rigName = rig.name; rigTag = rig.tag;
  if (plugin) plugin.loadRig(values, rig.name); else board.loadRig(values);
  for (const [id, c] of globals) c.set(values[id]);
  renderRack();
  const nm = $('rig-name');
  nm.textContent = rig.name; nm.classList.remove('swap'); void nm.offsetWidth; nm.classList.add('swap');
  $('rig-tag').textContent = rig.tag;
  $('browse').style.setProperty('--tagc', tagColour(rig.tag));
  markEdited(false);
  markLibrary();
  persist();
}

function step(dir: number): void {
  const list = allRigs();
  const i = list.findIndex((r) => r.name === rigName);
  loadRig(list[(i + dir + list.length) % list.length]);
}

// ---- the library -------------------------------------------------------------------

let libTab: 'rigs' | 'parts' = 'rigs';

function setTab(tab: 'rigs' | 'parts'): void {
  libTab = tab;
  $('tab-rigs').classList.toggle('on', tab === 'rigs'); $('tab-rigs').setAttribute('aria-selected', String(tab === 'rigs'));
  $('tab-parts').classList.toggle('on', tab === 'parts'); $('tab-parts').setAttribute('aria-selected', String(tab === 'parts'));
  $('lib-rigs').hidden = tab !== 'rigs';
  $('lib-parts').hidden = tab !== 'parts';
  $('lib-hint').hidden = tab !== 'parts';
  filterLibrary();
}

function openLibrary(tab: 'rigs' | 'parts', focusSearch = false): void {
  setTab(tab);
  document.body.classList.add('lib-open');
  if (focusSearch || narrow()) $<HTMLInputElement>('lib-search').focus();
}
function closeLibrary(): void { document.body.classList.remove('lib-open'); $('savebar').hidden = true; }

// Sections start collapsed; a search shows every match whatever is folded.
const openCats = new Set<string>();

function applyFold(list: HTMLElement, key: (el: HTMLElement) => string): void {
  const searching = $<HTMLInputElement>('lib-search').value.trim().length > 0;
  for (const el of list.querySelectorAll<HTMLElement>('.rig, .part, .empty')) {
    el.classList.toggle('folded', !searching && !openCats.has(key(el)));
  }
  for (const c of list.querySelectorAll<HTMLElement>('.cat')) {
    const on = openCats.has(key(c));
    c.classList.toggle('open', on || searching);
    c.setAttribute('aria-expanded', String(on || searching));
  }
}
const rigKey = (el: HTMLElement): string => `rigs:${el.dataset.tag}`;
const partKey = (el: HTMLElement): string => `parts:${el.dataset.cat}`;

function makeCat(head: HTMLElement, key: string, redo: () => void): void {
  head.tabIndex = 0; head.setAttribute('role', 'button');
  const flip = (): void => { if (openCats.has(key)) openCats.delete(key); else openCats.add(key); redo(); };
  head.addEventListener('click', flip);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
}

// ---- sharing ---------------------------------------------------------------------

/** Take in a rig that came from outside: kept under "your rigs" (a factory name gets a suffix) and loaded. */
function importRig(rig: Rig, keep: boolean): void {
  let name = rig.name;
  if (RIGS.some((r) => r.name.toLowerCase() === name.toLowerCase())) name = `${name.slice(0, 30)} (shared)`;
  const vals = { ...rigValues(rig) };
  loadRig({ name, tag: 'mine', values: () => vals });
  if (keep) {
    userRigs = [...userRigs.filter((u) => u.name !== name), { name, values: diffValues(vals) }];
    storeUserRigs(); buildRigList();
    toast(`added "${name}" to your rigs`);
  } else {
    markEdited(true);
    toast(`"${name}" was shared with you: save it to keep it`, 6000);
  }
  closeLibrary();
}

async function importText(text: string, keep: boolean): Promise<void> {
  try { importRig(await parseAny(text), keep); } catch (e) { toast(e instanceof Error ? e.message : 'that is not a rig'); }
}

async function shareRig(): Promise<void> {
  const link = shareLink(await encodeShare(toRig(values, rigName, rigTag)));
  try {
    await navigator.clipboard.writeText(link);
    $('share').classList.add('done'); setTimeout(() => $('share').classList.remove('done'), 900);
    toast('link copied: send it to anyone');
  } catch { window.prompt('copy this link', link); }
}

function newRig(): void {
  loadRig({ name: 'untitled', tag: 'mine', values: () => defaults() });
  closeLibrary();
}

function buildRigList(): void {
  const list = $('lib-rigs');
  list.textContent = '';
  const rigs = allRigs();
  for (const tag of [...RIG_TAGS, 'mine']) {
    const inTag = rigs.filter((r) => r.tag === tag);
    const cat = document.createElement('div');
    cat.className = 'cat'; cat.dataset.tag = tag; cat.style.setProperty('--tagc', tagColour(tag));
    cat.innerHTML = '<span></span><span class="count"></span>';
    (cat.firstChild as HTMLElement).textContent = tag === 'mine' ? 'your rigs' : tag;
    (cat.lastChild as HTMLElement).textContent = String(inTag.length);
    makeCat(cat, `rigs:${tag}`, () => applyFold(list, rigKey));
    list.append(cat);
    if (inTag.length === 0) {
      const e = document.createElement('div'); e.className = 'empty'; e.dataset.tag = tag;
      e.textContent = 'nothing saved yet: dial a rig in and press save';
      list.append(e);
    }
    for (const r of inTag) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'rig'; row.dataset.tag = tag; row.dataset.name = r.name;
      row.style.setProperty('--tagc', tagColour(tag));
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
      const mods = document.createElement('span'); mods.className = 'mods';
      mods.textContent = units(r.values()).map((s) => MODULES[Math.round(r.values()[slotTypeId(s)])].name).join(' · ');
      row.append(nm, mods);
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.del')) return;
        loadRig(r);
        if (narrow()) closeLibrary();
      });
      if (tag === 'mine') {
        const del = document.createElement('span');
        del.className = 'del'; del.textContent = '×'; del.title = 'delete this rig'; del.setAttribute('role', 'button');
        del.addEventListener('click', () => {
          if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'delete?'; return; }
          userRigs = userRigs.filter((u) => u.name !== r.name);
          storeUserRigs();
          buildRigList();
        });
        row.append(del);
      }
      list.append(row);
    }
  }
  markLibrary();
  filterLibrary();
  applyFold(list, rigKey);
}

function buildPartList(): void {
  const list = $('lib-parts');
  list.textContent = '';
  for (const cat of CATEGORIES) {
    const head = document.createElement('div');
    head.className = 'cat'; head.dataset.cat = cat;
    head.innerHTML = '<span></span>';
    (head.firstChild as HTMLElement).textContent = cat;
    makeCat(head, `parts:${cat}`, () => applyFold(list, partKey));
    list.append(head);
    MODULES.forEach((m, type) => {
      if (m.cat !== cat || m.hidden || (m.pluginOnly && !plugin)) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'part'; b.draggable = true; b.dataset.cat = cat;
      b.dataset.search = `${m.name} ${m.id} ${m.blurb} ${cat}`.toLowerCase();
      b.style.setProperty('--accent', m.accent);
      b.title = `add the ${m.name} at the end of the rack (or drag it into place)`;
      const sw = document.createElement('span'); sw.className = 'sw';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = m.name;
      const bl = document.createElement('span'); bl.className = 'bl'; bl.textContent = m.blurb;
      const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '+';
      b.append(sw, nm, bl, plus);
      b.addEventListener('click', () => { addModule(type); if (narrow()) closeLibrary(); });
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DT_MODULE, String(type));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      b.addEventListener('dragend', hideDrop);
      list.append(b);
    });
  }
  applyFold(list, partKey);
}

function markLibrary(): void {
  for (const c of $('lib-rigs').querySelectorAll<HTMLElement>('.rig')) {
    const on = c.dataset.name === rigName;
    c.classList.toggle('on', on);
    c.setAttribute('aria-current', String(on));
  }
}

function filterLibrary(): void {
  const q = $<HTMLInputElement>('lib-search').value.trim().toLowerCase();
  const rigs = $('lib-rigs'), parts = $('lib-parts');
  for (const c of rigs.querySelectorAll<HTMLElement>('.rig')) c.hidden = q.length > 0 && !`${c.dataset.name} ${c.dataset.tag} ${c.querySelector('.mods')?.textContent}`.toLowerCase().includes(q);
  for (const e of rigs.querySelectorAll<HTMLElement>('.empty')) e.hidden = q.length > 0;
  for (const cat of rigs.querySelectorAll<HTMLElement>('.cat')) {
    cat.hidden = q.length > 0 && !rigs.querySelector(`.rig[data-tag="${cat.dataset.tag}"]:not([hidden])`);
  }
  for (const p of parts.querySelectorAll<HTMLElement>('.part')) p.hidden = q.length > 0 && !(p.dataset.search ?? '').includes(q);
  for (const cat of parts.querySelectorAll<HTMLElement>('.cat')) {
    cat.hidden = q.length > 0 && !parts.querySelector(`.part[data-cat="${cat.dataset.cat}"]:not([hidden])`);
  }
  applyFold(rigs, rigKey); applyFold(parts, partKey);
}

function openSave(): void {
  openLibrary('rigs');
  $('savebar').hidden = false;
  const n = $<HTMLInputElement>('save-name');
  n.value = RIGS.some((r) => r.name === rigName) ? `${rigName} (mine)` : rigName;
  $('save-msg').textContent = '';
  n.focus(); n.select();
}

function saveRig(): void {
  const name = $<HTMLInputElement>('save-name').value.trim().slice(0, 40);
  if (!name) { $('save-msg').textContent = 'give it a name'; return; }
  if (RIGS.some((r) => r.name.toLowerCase() === name.toLowerCase())) { $('save-msg').textContent = 'a factory rig has that name'; return; }
  userRigs = [...userRigs.filter((u) => u.name !== name), { name, values: diffValues(values) }];
  storeUserRigs();
  rigName = name; rigTag = 'mine';
  $('rig-name').textContent = name; $('rig-tag').textContent = 'mine';
  $('browse').style.setProperty('--tagc', tagColour('mine'));
  markEdited(false);
  $('savebar').hidden = true;
  buildRigList();
  persist();
  if (narrow()) closeLibrary();
  toast(`saved "${name}"`);
}

// ---- input source ---------------------------------------------------------------

async function refreshDevices(): Promise<void> {
  const sel = $<HTMLSelectElement>('device');
  const devs = await board.inputDevices();
  sel.textContent = '';
  for (const d of devs) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; sel.append(o); }
  if (devs.some((d) => d.id === device)) sel.value = device;
}

async function setSource(next: string): Promise<void> {
  const sel = $<HTMLSelectElement>('source');
  if (next === 'file') { $<HTMLInputElement>('file').click(); sel.value = source; return; }
  source = next; sel.value = next;
  $('live-row').classList.toggle('show', next === 'live');
  $('iface-row').classList.toggle('show', next === 'live');
  if (plugin) { plugin.setSource(next === 'live' ? SRC_LIVE : SRC_DEMO, Number(next.split(':')[1] ?? 0)); return; }
  if (!board.running) { persist(); return; }
  if (next === 'live') {
    try {
      const label = await board.openInput(device || null);
      board.setChannel(channel);
      board.setSource(SRC_LIVE);
      await refreshDevices();
      if (/built-?in|macbook|internal/i.test(label)) toast('that is the built-in mic: use headphones, or it will feed back', 6000);
    } catch (e) {
      toast(`no input: ${(e as Error).message || 'permission refused'}`, 6000);
      source = 'demo:0'; sel.value = source; board.setSource(SRC_DEMO, 0);
      $('live-row').classList.remove('show');
      $('iface-row').classList.remove('show');
    }
  } else {
    board.closeInput();
    board.setSource(SRC_DEMO, Number(next.split(':')[1] ?? 0));
  }
  persist();
}

async function useFile(f: File): Promise<void> {
  if (!board.running) await power(true);
  try {
    const secs = await board.loadFile(f);
    board.closeInput();
    board.setSource(SRC_FILE);
    source = 'file';
    const sel = $<HTMLSelectElement>('source');
    const opt = sel.querySelector<HTMLOptionElement>('option[value="file"]')!;
    opt.textContent = `file · ${f.name.slice(0, 24)}`;
    sel.value = 'file';
    $('live-row').classList.remove('show');
    $('iface-row').classList.remove('show');
    toast(`looping ${f.name} (${secs.toFixed(1)} s)`);
  } catch {
    toast('could not read that file as audio');
  }
}

// ---- power -----------------------------------------------------------------------

async function power(on: boolean): Promise<void> {
  const btn = $('start'), label = $('start-label');
  if (on) {
    btn.setAttribute('disabled', '');
    try {
      await board.start();
      board.loadRig(values);
      board.setParam('volume', values.volume);
      board.mute(tunerMute);
      await setSource(source === 'file' ? 'demo:0' : source);
      btn.classList.add('on'); label.textContent = 'on';
      btn.title = 'switch the rack off';
      document.body.classList.remove('asleep');
    } catch (e) {
      toast(`audio would not start: ${(e as Error).message}`, 6000);
    } finally { btn.removeAttribute('disabled'); }
  } else {
    await board.suspend();
    board.closeInput();
    btn.classList.remove('on'); label.textContent = 'off';
    btn.title = 'switch the rack on';
    document.body.classList.add('asleep');
  }
}

// ---- tuner ----------------------------------------------------------------------

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
let tunerCents = 0, tunerNote = -1, tunerSeen = 0;
function updateTuner(hz: number, clarity: number, now: number): void {
  const note = $('tuner-note'), cents = $('tuner-cents'), needle = $('tuner-needle'), box = $('tuner');
  if (hz > 0 && clarity > 0.85) {
    const midi = 69 + 12 * Math.log2(hz / 440), n = Math.round(midi), c = (midi - n) * 100;
    tunerCents = n === tunerNote ? tunerCents + (c - tunerCents) * 0.35 : c;
    tunerNote = n; tunerSeen = now;
    note.textContent = `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
    cents.textContent = `${tunerCents >= 0 ? '+' : '−'}${Math.abs(tunerCents).toFixed(0)} ct`;
    needle.style.left = `${50 + Math.max(-50, Math.min(50, tunerCents))}%`;
    box.classList.toggle('in', Math.abs(tunerCents) < 3);
    box.classList.add('live');
  } else if (now - tunerSeen > 700) {
    box.classList.remove('live', 'in');
    note.textContent = '–';
    cents.textContent = tunerMute ? 'muted' : 'tuner';
  }
}

function setTunerMute(m: boolean): void {
  tunerMute = m;
  board.mute(m);
  $('tuner').classList.toggle('muted', m);
  $('tuner').setAttribute('aria-pressed', String(m));
  if (!$('tuner').classList.contains('live')) $('tuner-cents').textContent = m ? 'muted' : 'tuner';
}

// ---- meters & frames ------------------------------------------------------------------

let fresh: WorkletStats | null = null;
let latest: WorkletStats | null = null;
let peakHold = 0;
board.onStats = (s) => { fresh = s; latest = s; };

const meterDb = (x: number) => Math.max(0, Math.min(1, (20 * Math.log10(x + 1e-9) + 60) / 60));
let inClipUntil = 0, outClipUntil = 0;
// the input meter reads volts at the rack's input (the interface reference turns the track's samples into volts),
// from -60 to +6 dBV. A passive pickup peaks between ~0.1 V (soft playing) and ~1 V (a humbucker strummed hard:
// single coils 0.25-0.45 V, bridge humbuckers 0.6-0.85 V), so that is the green band; under 0.03 V the drives
// and amps hear far less than a real guitar gives them (check the interface reference), over 2 V is hot
const inMeterDb = (x: number) => Math.max(0, Math.min(1, (20 * Math.log10(x + 1e-9) + 60) / 66));
const IN_ZONE: [number, number] = [0.1, 1], IN_LOW = 0.03, IN_HOT = 2;
const IN_HINTS: Record<string, string> = { idle: '–', low: 'quiet · raise input', near: 'a little low', good: 'good level', hot: 'hot · ease input', over: 'too hot · lower input' };
let inHold = 0, inHoldUntil = 0, inSeen = 0, inState = 'idle';
const NO_STAGES = new Float32Array(STAGE_STRIDE);

const spine = new Spine($<HTMLCanvasElement>('spine'), (i) => { const v = views[i]; if (v) toggle(v.slot); });
const stage = new Stage($<HTMLCanvasElement>('stage'));

function frame(now: number): void {
  const s = fresh;
  if (s) {
    const out = Math.max(s.peakL, s.peakR);
    let heat = 0;
    for (const v of views) if (drives(v.type) && isOn(v.slot)) heat = Math.max(heat, s.slotHeat[v.slot]);
    stage.feed(out, heat);
    spine.setLive({ inPeak: s.peakIn, slotPeak: s.slotPeak, slotHeat: s.slotHeat });
    $('in-meter').style.width = `${inMeterDb(s.peakIn) * 100}%`;
    // the peak is held for a moment so it can be read, then follows the signal down
    if (s.peakIn >= inHold || now > inHoldUntil) { inHold = s.peakIn; inHoldUntil = now + 1500; }
    if (s.peakIn > 0.003) inSeen = now;
    $('in-hold').style.left = `${inMeterDb(inHold) * 100}%`;
    const st = now - inSeen > 3000 ? 'idle' : inHold < IN_LOW ? 'low' : inHold < IN_ZONE[0] ? 'near' : inHold <= IN_ZONE[1] ? 'good' : inHold <= IN_HOT ? 'hot' : 'over';
    if (st !== inState) { inState = st; const h = $('in-hint'); h.dataset.state = st; h.textContent = IN_HINTS[st]; }
    $('out-meter').style.width = `${meterDb(out) * 100}%`;
    if (s.peakRaw > 0.98) inClipUntil = now + 1200;   // the interface itself clipping
    if (out > 0.98) outClipUntil = now + 1200;
    $('in-clip').classList.toggle('on', now < inClipUntil);
    $('out-clip').classList.toggle('on', now < outClipUntil);
    peakHold = Math.max(peakHold * 0.95, s.load);
    const dsp = `${(peakHold * 100).toFixed(0).padStart(2)}% dsp`;
    $('stats').textContent = plugin ? dsp : board.running ? `≈ ${board.latencyMs.toFixed(0)} ms · ${dsp}` : '';
    updateTuner(s.tunerHz, s.tunerClarity, now);
    for (const v of views) v.lvl.style.width = `${meterDb(s.slotPeak[v.slot]) * 100}%`;
    fresh = null;
  }
  // the spine's sockets sit on the units' heads
  spine.setNodes(views.map((v) => ({ y: v.el.offsetTop + 19, colour: MODULES[v.type].accent, on: isOn(v.slot), drives: drives(v.type) })));
  stage.draw(now);
  spine.draw(now);
  const l = latest;
  for (const v of views) {
    if (!isOn(v.slot) || folded[v.slot]) continue;
    const live: VizLive = l
      ? { live: l.slotLive[v.slot], heat: l.slotHeat[v.slot], stages: l.stageHeat.subarray(v.slot * STAGE_STRIDE, (v.slot + 1) * STAGE_STRIDE) }
      : { live: 0, heat: 0, stages: NO_STAGES };
    const k = MODULES[v.type].knobs.map((d, i) => fromNorm(d, values[slotKnobId(v.slot, i)]));
    v.viz.draw(k, live, MODULES[v.type].accent, now);
  }
  requestAnimationFrame(frame);
}

// ---- wiring the page up ---------------------------------------------------------

/** The interface reference list: where a 1 V peak lands on your interface (−13 dBFS is typical at minimum gain). */
function buildIface(): void {
  const sel = $<HTMLSelectElement>('iface'), def = PARAM_BY_ID.iface;
  for (let d = def.max; d >= def.min; d--) {
    const o = document.createElement('option');
    o.value = String(d);
    o.textContent = `${d < 0 ? '−' : ''}${Math.abs(d)} dB${d === def.def ? ' ·' : ''}`;
    sel.append(o);
  }
}
function showIface(): void {
  const sel = $<HTMLSelectElement>('iface'), v = Math.round(values.iface);
  sel.value = String(v);
}

function init(): void {
  for (const [slot, id, hero] of [['in-gain', 'inGain', false], ['heat', 'heat', true]] as const) {
    const c = makeControl(PARAM_BY_ID[id], values[id], (v) => setValue(id, v), { size: hero ? 58 : 44, hero });
    c.el.dataset.hint = hintFor('', id);
    c.el.title = id === 'heat' ? 'heat: pushes every drive and amp harder (or backs them off) together' : 'input gain: match your pickups';
    globals.set(id, c);
    $(slot).append(c.el);
  }
  const zone = $('in-zone');
  zone.style.left = `${inMeterDb(IN_ZONE[0]) * 100}%`;
  zone.style.width = `${(inMeterDb(IN_ZONE[1]) - inMeterDb(IN_ZONE[0])) * 100}%`;
  buildIface();
  buildPartList();
  wireControls();
  wireDoctor();
  wireHints();
  requestAnimationFrame(frame);
  if (plugin) {
    // the plugin's page has no address bar, clipboard or downloads; sharing there is the user-rigs file
    for (const id of ['share', 'export', 'import']) $(id).style.display = 'none';
    initPlugin(plugin); return;
  }

  const saved = loadState();
  if (saved.volume !== undefined) values.volume = saved.volume;
  if (saved.iface !== undefined) values.iface = saved.iface;
  $<HTMLInputElement>('volume').value = String(values.volume);
  showIface();
  if (saved.source) source = saved.source;
  if (saved.device) device = saved.device;
  if (saved.channel !== undefined) channel = saved.channel;
  $<HTMLSelectElement>('channel').value = String(channel);
  $<HTMLSelectElement>('source').value = source;
  $('live-row').classList.toggle('show', source === 'live');
  $('iface-row').classList.toggle('show', source === 'live');
  const rig = allRigs().find((r) => r.name === saved.rig) ?? allRigs()[0];
  buildRigList();
  loadRig(rig);
  if (saved.values && saved.rig === rig.name) {
    // your edits on top of it
    const v = pack({ ...defaults(), ...saved.values, volume: values.volume, iface: values.iface }).values;
    if (units(v).length > 0 && Object.keys(v).some((k) => v[k] !== values[k])) {
      values = v;
      board.loadRig(values);
      for (const [id, c] of globals) c.set(values[id]);
      renderRack();
      markEdited(true);
    }
  }
  const code = codeInHash(location.hash);
  if (code) {
    history.replaceState(null, '', location.pathname + location.search);
    decodeShare(code).then((r) => importRig(r, false), (e) => toast(e instanceof Error ? e.message : 'that link is not a rig'));
  }
  window.addEventListener('hashchange', () => {
    const c = codeInHash(location.hash);
    if (!c) return;
    history.replaceState(null, '', location.pathname + location.search);
    decodeShare(c).then((r) => importRig(r, false), (e) => toast(e instanceof Error ? e.message : 'that link is not a rig'));
  });
  document.body.classList.add('asleep');
}

function wireControls(): void {
  wireDrops();

  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('browse').addEventListener('click', () => openLibrary('rigs', true));
  $('open-lib').addEventListener('click', () => openLibrary('parts', true));
  $('lib-close').addEventListener('click', closeLibrary);
  $('tab-rigs').addEventListener('click', () => setTab('rigs'));
  $('tab-parts').addEventListener('click', () => setTab('parts'));
  $('lib-search').addEventListener('input', filterLibrary);
  $('save').addEventListener('click', openSave);
  $('new-rig').addEventListener('click', newRig);
  $('savebar').addEventListener('submit', (e) => { e.preventDefault(); saveRig(); });
  $('save-cancel').addEventListener('click', () => { $('savebar').hidden = true; });
  $('share').addEventListener('click', shareRig);
  $('export').addEventListener('click', () => downloadRig(toRig(values, rigName, rigTag)));
  $('import').addEventListener('click', () => $('rig-file').click());
  $<HTMLInputElement>('rig-file').addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement, f = el.files?.[0];
    if (f) await importText(await f.text(), true);
    el.value = '';
  });
  // a share link or rig JSON pasted anywhere but a text field
  window.addEventListener('paste', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.includes('#rig=') || text.trimStart().startsWith('{"')) { e.preventDefault(); void importText(text, true); }
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(toRig(values, rigName, rigTag), null, 2));
      $('copy').classList.add('done'); setTimeout(() => $('copy').classList.remove('done'), 900);
    } catch { toast('the clipboard is blocked here'); }
  });
  $<HTMLInputElement>('volume').addEventListener('input', (e) => setValue('volume', Number((e.target as HTMLInputElement).value), false));
  $('start').addEventListener('click', () => power(!board.running));
  $('wake').addEventListener('click', () => power(true));
  $('tuner').addEventListener('click', () => setTunerMute(!tunerMute));
  $<HTMLSelectElement>('source').addEventListener('change', (e) => setSource((e.target as HTMLSelectElement).value));
  $<HTMLSelectElement>('device').addEventListener('change', (e) => { device = (e.target as HTMLSelectElement).value; setSource('live'); });
  $<HTMLSelectElement>('channel').addEventListener('change', (e) => { channel = Number((e.target as HTMLSelectElement).value); board.setChannel(channel); persist(); });
  $<HTMLSelectElement>('iface').addEventListener('change', (e) => setValue('iface', Number((e.target as HTMLSelectElement).value), false));
  $<HTMLInputElement>('file').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) useFile(f); (e.target as HTMLInputElement).value = ''; });
  // an audio file dropped anywhere but the rack loops as the input
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); document.body.classList.add('dropping');
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (/\.json$/i.test(f.name)) void f.text().then((t) => importText(t, true)); else useFile(f);
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (source === 'live') refreshDevices(); });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); return; }
    if (e.key === 'Escape') { closeLibrary(); (document.activeElement as HTMLElement)?.blur?.(); return; }
    if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/' || e.key === '`') { e.preventDefault(); openLibrary(libTab, true); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 't' || e.key === 'T') setTunerMute(!tunerMute);
    else if (/^[1-9]$/.test(e.key)) { const v = views[Number(e.key) - 1]; if (v) toggle(v.slot); }
  });

  // for the headless check
  (window as unknown as Record<string, unknown>).__pedalboard = {
    board, power, setSource, setValue,
    loadRig: (name: string) => { const r = allRigs().find((x) => x.name === name); if (r) loadRig(r); return !!r; },
    add: (id: string, at?: number) => addModule(MODULES.findIndex((m) => m.id === id), at),
    move: (from: number, to: number) => { const r = moveUnit(values, from, to); commit(r.values, r.perm); },
    remove: (slot: number) => { const r = removeUnit(values, slot); commit(r.values, r.perm); },
    rack: () => units(values).map((s) => MODULES[typeOf(s)].id),
    values: () => ({ ...values }),
    lastStats: () => lastStats,
  };
}

// ---- inside the plugin -------------------------------------------------------

/** Show the rig the host has (on open, a session load, the host's preset menu). */
function applyHostState(hostValues: ParamValues, preset: string): void {
  values = { ...defaults(), ...hostValues } as ParamValues;
  folded = new Array(NSLOTS).fill(false);
  const isEdited = preset.startsWith('*');
  const name = isEdited ? preset.slice(1) : preset;
  rigName = name || 'your rack';
  rigTag = allRigs().find((r) => r.name === name)?.tag ?? 'mine';
  for (const [id, c] of globals) c.set(values[id]);
  $<HTMLInputElement>('volume').value = String(values.volume);
  showIface();
  renderRack();
  $('rig-name').textContent = rigName;
  $('rig-tag').textContent = rigTag;
  $('browse').style.setProperty('--tagc', tagColour(rigTag));
  edited = isEdited || !name;
  $('browse').classList.toggle('edited', edited);
  markLibrary();
}

function initPlugin(p: PluginBoard): void {
  const sel = $<HTMLSelectElement>('source');
  sel.querySelector<HTMLOptionElement>('option[value="live"]')!.textContent = 'track input';
  sel.querySelector('option[value="file"]')?.remove();
  $('device').remove();
  p.onState = (st) => {
    userRigs = st.user.map((r) => ({ name: r.name, values: cleanValues(r.values) }));
    buildRigList();
    applyHostState(st.values, st.preset);
    source = st.source; sel.value = st.source;
    channel = st.channel; $<HTMLSelectElement>('channel').value = String(channel);
    $('live-row').classList.toggle('show', source === 'live');
    $('iface-row').classList.toggle('show', source === 'live');
    tunerMute = st.muted; $('tuner').classList.toggle('muted', st.muted);
  };
  // automation and the host's own editor
  p.onIR = (n) => setLoaded('ir', n);
  p.onNAM = (n, err) => { setLoaded('nam', n); if (err) toast(`NAM: ${err}`); };
  p.onParams = (changed) => {
    let rebuild = false;
    for (const id in changed) {
      const v = changed[id]!;
      values[id] = v;
      globals.get(id)?.set(v);
      if (id === 'volume') $<HTMLInputElement>('volume').value = String(v);
      if (id === 'iface') showIface();
      const m = /^s(\d)(type|on|k(\d+))$/.exec(id);
      if (!m) continue;
      const slot = Number(m[1]) - 1, view = views.find((x) => x.slot === slot);
      if (m[2] === 'type' || !view) rebuild = true;
      else if (m[2] === 'on') refreshUnit(view);
      else {
        const k = Number(m[3]) - 1, def = MODULES[view.type].knobs[k];
        if (def) view.controls[k].set(fromNorm(def, v));
      }
    }
    if (rebuild) renderRack();
  };
  p.ready();
}

// keep the latest stats for the headless check
let lastStats: { peakL: number; peakR: number; peakIn: number; tunerHz: number } | null = null;
const onStats = board.onStats;
board.onStats = (s) => { lastStats = { peakL: s.peakL, peakR: s.peakR, peakIn: s.peakIn, tunerHz: s.tunerHz }; onStats?.(s); };

init();
