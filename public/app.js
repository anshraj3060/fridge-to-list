// Fridge to List — browser UI. No framework, no build step, no network calls
// outside this origin (the server does the talking to local Ollama).

import { cleanText, REASON_LABELS, titleCase } from '/lib/normalize.js';
import {
  DEFAULT_STAPLES,
  canonicalKey,
  classifySection,
  diffStaples,
  groupBySection,
  listToText,
  matchesStaple,
} from '/lib/staples.js';
import { ApiError, analyzePhotos, fetchModels } from '/lib/api.js';

const STORAGE = {
  staples: 'ftl.staples.v1',
  model: 'ftl.model.v1',
  list: 'ftl.list.v1',
};

const MAX_PHOTOS = 4;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CLIENT_TIMEOUT_MS = 200_000;
const MAX_EDGE = 1024;

const $ = (selector) => document.querySelector(selector);

const dom = {
  photoInput: $('#photoInput'),
  dropzone: $('#dropzone'),
  browseButton: $('#browseButton'),
  thumbList: $('#thumbList'),
  thumbCount: $('#photoCount'),
  analyzeButton: $('#analyzeButton'),
  analyzeLabel: $('#analyzeButton .button-label'),
  clearPhotosButton: $('#clearPhotosButton'),
  photoError: $('#photoError'),
  progress: $('#progress'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  progressTimer: $('#progressTimer'),
  progressHint: $('#progressHint'),
  cancelButton: $('#cancelButton'),
  stapleList: $('#stapleList'),
  stapleForm: $('#stapleForm'),
  stapleInput: $('#stapleInput'),
  resetStaples: $('#resetStaples'),
  errorCard: $('#errorCard'),
  errorTitle: $('#errorTitle'),
  errorMessage: $('#errorMessage'),
  errorHint: $('#errorHint'),
  errorCommandsWrap: $('#errorCommandsWrap'),
  errorCommands: $('#errorCommands'),
  copyCommands: $('#copyCommands'),
  retryButton: $('#retryButton'),
  errorSettingsButton: $('#errorSettingsButton'),
  resultCard: $('#resultCard'),
  resultSub: $('#resultSub'),
  timing: $('#timing'),
  rebuiltNote: $('#rebuiltNote'),
  listBody: $('#listBody'),
  listEmpty: $('#listEmpty'),
  listNote: $('#listNote'),
  itemForm: $('#itemForm'),
  itemInput: $('#itemInput'),
  copyButton: $('#copyButton'),
  downloadButton: $('#downloadButton'),
  uncheckButton: $('#uncheckButton'),
  seenCard: $('#seenCard'),
  seenToggle: $('#seenToggle'),
  seenBody: $('#seenBody'),
  seenList: $('#seenList'),
  seenSub: $('#seenSub'),
  seenStats: $('#seenStats'),
  unclearWrap: $('#unclearWrap'),
  unclearList: $('#unclearList'),
  settingsButton: $('#settingsButton'),
  settingsDialog: $('#settingsDialog'),
  modelLabel: $('#modelLabel'),
  modelDot: $('#modelDot'),
  modelSelect: $('#modelSelect'),
  modelHelp: $('#modelHelp'),
  ollamaDot: $('#ollamaDot'),
  ollamaStatusText: $('#ollamaStatusText'),
  refreshModels: $('#refreshModels'),
  saveSettings: $('#saveSettings'),
  resetModel: $('#resetModel'),
  demoButton: $('#demoButton'),
  demoDialog: $('#demoDialog'),
  toast: $('#toast'),
};

const state = {
  photos: [],
  staples: loadStaples(),
  model: readStorage(STORAGE.model) || '',
  defaultModel: 'gemma3:4b',
  models: [],
  online: null, // null = unknown, true/false after a model check
  list: loadList(),
  analyzing: false,
  controller: null,
  progressTimer: null,
  progressStartedAt: 0,
  progressMessages: null,
  toastTimer: null,
};

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode, quota, etc. The app still works in memory. */
  }
}

function loadStaples() {
  try {
    const parsed = JSON.parse(readStorage(STORAGE.staples) || 'null');
    if (Array.isArray(parsed)) {
      const cleaned = dedupeNames(parsed).slice(0, 60);
      return cleaned.length ? cleaned : [...DEFAULT_STAPLES];
    }
  } catch {
    /* fall through to defaults */
  }
  return [...DEFAULT_STAPLES];
}

function saveStaples() {
  writeStorage(STORAGE.staples, JSON.stringify(state.staples));
}

function loadList() {
  try {
    const parsed = JSON.parse(readStorage(STORAGE.list) || 'null');
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return {
      items: parsed.items.filter((item) => item && typeof item.name === 'string'),
      alreadyHave: Array.isArray(parsed.alreadyHave) ? parsed.alreadyHave : [],
      unknownStaples: Array.isArray(parsed.unknownStaples) ? parsed.unknownStaples : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      unclear: Array.isArray(parsed.unclear) ? parsed.unclear : [],
      checked: Array.isArray(parsed.checked) ? parsed.checked : [],
      model: typeof parsed.model === 'string' ? parsed.model : '',
      durationMs: Number(parsed.durationMs) || 0,
      photoCount: Number(parsed.photoCount) || 0,
      stats: parsed.stats || null,
      attempts: Number(parsed.attempts) || 1,
      at: Number(parsed.at) || 0,
    };
  } catch {
    return null;
  }
}

function saveList() {
  if (!state.list) {
    writeStorage(STORAGE.list, null);
    return;
  }
  writeStorage(STORAGE.list, JSON.stringify({ ...state.list, restored: false }));
}

function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const clean = cleanText(name, 40);
    const key = canonicalKey(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function toast(message, { duration = 3200 } = {}) {
  clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, duration);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { value: text, class: 'visually-hidden' });
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* photos                                                              */
/* ------------------------------------------------------------------ */

function showPhotoError(message) {
  if (!message) {
    dom.photoError.hidden = true;
    dom.photoError.textContent = '';
    return;
  }
  dom.photoError.textContent = message;
  dom.photoError.hidden = false;
}

async function fileToPhoto(file) {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    throw new Error(`"${file.name}" is not a JPEG, PNG or WebP image.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`"${file.name}" is over 25 MB. A normal phone photo is fine.`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`"${file.name}" could not be opened.`));
      };
      img.src = url;
    });
  }

  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  canvas.width = outWidth;
  canvas.height = outHeight;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, outWidth, outHeight);
  if (typeof bitmap.close === 'function') bitmap.close();

  // Keep the data URL in memory only. Nothing is uploaded or written to disk.
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = 0;
  canvas.height = 0;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || 'photo.jpg',
    dataUrl,
    width: outWidth,
    height: outHeight,
  };
}

async function addFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  showPhotoError('');
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) {
    showPhotoError(`Four photos at a time is the limit. Remove one to swap it out.`);
    return;
  }
  const accepted = files.slice(0, room);
  const skipped = files.length - accepted.length;

  const errors = [];
  for (const file of accepted) {
    try {
      state.photos.push(await fileToPhoto(file));
      renderPhotos();
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) showPhotoError(errors.join(' '));
  else if (skipped > 0) showPhotoError(`Kept the first four photos. The other ${skipped} were ignored.`);
  renderPhotos();
}

function renderPhotos() {
  dom.thumbList.replaceChildren();
  for (const photo of state.photos) {
    const remove = el('button', {
      class: 'thumb-remove',
      type: 'button',
      'aria-label': `Remove ${photo.name}`,
      title: 'Remove photo',
      text: '×',
    });
    remove.addEventListener('click', () => {
      state.photos = state.photos.filter((entry) => entry.id !== photo.id);
      showPhotoError('');
      renderPhotos();
    });
    dom.thumbList.append(
      el('li', { class: 'thumb' }, [
        el('img', { src: photo.dataUrl, alt: `Photo ${photo.name}` }),
        el('span', { class: 'thumb-name', text: photo.name }),
        remove,
      ]),
    );
  }
  dom.thumbCount.textContent = `${state.photos.length} / ${MAX_PHOTOS}`;
  dom.analyzeButton.disabled = state.photos.length === 0 || state.analyzing;
  dom.clearPhotosButton.hidden = state.photos.length === 0;
  dom.clearPhotosButton.disabled = state.analyzing;
}

/* ------------------------------------------------------------------ */
/* progress                                                            */
/* ------------------------------------------------------------------ */

const PROGRESS_LINES = [
  'Reading the shelves…',
  'Squinting at that jar…',
  'Counting the eggs, roughly…',
  'Cross-checking the door shelf…',
  'Deciding what counts as a vegetable…',
  'Writing it down, slowly…',
];

function startProgress() {
  state.progressStartedAt = performance.now();
  dom.progress.hidden = false;
  dom.progressTimer.textContent = '0.0s';
  dom.progressText.textContent = PROGRESS_LINES[0];
  dom.progressHint.textContent =
    'First look can take a minute or two while the model wakes up. Perfect time to do nothing.';
  dom.progressHint.hidden = false;
  dom.analyzeLabel.textContent = 'Thinking, slowly…';

  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(() => {
    const elapsed = performance.now() - state.progressStartedAt;
    dom.progressTimer.textContent = formatSeconds(elapsed);
    if (elapsed > 45_000) {
      dom.progressHint.textContent =
        'Still going. Small models load into memory the first time, which is the slow part. Nothing is stuck.';
    }
  }, 120);

  let index = 0;
  clearInterval(state.progressMessages);
  state.progressMessages = setInterval(() => {
    index = (index + 1) % PROGRESS_LINES.length;
    dom.progressText.textContent = PROGRESS_LINES[index];
  }, 9000);
}

function stopProgress() {
  clearInterval(state.progressTimer);
  clearInterval(state.progressMessages);
  state.progressTimer = null;
  state.progressMessages = null;
  dom.progress.hidden = true;
  dom.analyzeLabel.textContent = 'Look at my fridge';
}

/* ------------------------------------------------------------------ */
/* staples                                                            */
/* ------------------------------------------------------------------ */

function renderStaples() {
  dom.stapleList.replaceChildren();
  if (!state.staples.length) {
    dom.stapleList.append(el('li', { class: 'chip-empty', text: 'No staples yet. Add a few you always keep.' }));
    return;
  }
  for (const staple of state.staples) {
    const remove = el('button', {
      type: 'button',
      'aria-label': `Remove ${staple}`,
      title: `Remove ${staple}`,
      text: '×',
    });
    remove.addEventListener('click', () => {
      state.staples = state.staples.filter((entry) => entry !== staple);
      saveStaples();
      renderStaples();
      onStaplesChanged();
    });
    dom.stapleList.append(el('li', { class: 'chip' }, [el('span', { text: titleCase(staple) }), remove]));
  }
}

function onStaplesChanged() {
  if (!state.list) return;
  rebuildList();
}

function rebuildList() {
  const list = state.list;
  const manual = list.items.filter((item) => item.reason === 'manual');
  const fresh = diffStaples({ staples: state.staples, seen: list.seen, manual });
  list.items = fresh.items;
  list.alreadyHave = fresh.alreadyHave;
  list.unknownStaples = fresh.unknownStaples;
  list.checked = list.checked.filter((key) => fresh.items.some((item) => item.key === key));
  saveList();
  renderResult({ rebuilt: true });
}

/* ------------------------------------------------------------------ */
/* result + list                                                       */
/* ------------------------------------------------------------------ */

function hasConfidence(item) {
  return ['high', 'medium', 'low'].includes(item.confidence);
}

function reasonLabel(item) {
  return REASON_LABELS[item.reason] || 'on your list';
}

function renderResult({ rebuilt = false, restored = false } = {}) {
  if (!state.list) {
    dom.resultCard.hidden = true;
    dom.seenCard.hidden = true;
    return;
  }
  const list = state.list;
  dom.resultCard.hidden = false;
  dom.seenCard.hidden = false;

  const when = list.at ? `checked at ${formatClock(list.at)}` : 'a previous run';
  const photos = list.photoCount ? plural(list.photoCount, 'photo') : 'your photos';
  const prefix = restored ? 'Restored from your last run — ' : '';
  dom.resultSub.textContent = `${prefix}${photos}, ${list.model || 'unknown model'}, ${when}.`;

  if (list.durationMs) {
    dom.timing.replaceChildren(
      el('span', { class: 'seconds', text: formatSeconds(list.durationMs) }),
      el('span', { class: 'timing-label', text: 'to write this list' }),
    );
    dom.timing.title = `Measured on the server, from request to validated JSON.${list.attempts > 1 ? ` The model needed ${list.attempts} tries to produce clean JSON.` : ''}`;
  } else {
    dom.timing.replaceChildren();
  }

  dom.rebuiltNote.hidden = !rebuilt;
  if (rebuilt) {
    dom.rebuiltNote.textContent = 'Staples changed, so the list was rebuilt. Items you added by hand stayed put.';
  }

  renderListBody();
  renderSeen(restored);
}

function renderListBody() {
  const list = state.list;
  const checked = new Set(list.checked);
  const groups = groupBySection(list.items);
  dom.listBody.replaceChildren();

  for (const group of groups) {
    const items = [];
    for (const item of group.items) {
      const checkbox = el('input', {
        type: 'checkbox',
        checked: checked.has(item.key),
        id: `check-${item.key.replace(/\s+/g, '-')}`,
      });
      checkbox.addEventListener('change', () => {
        const current = new Set(list.checked);
        if (checkbox.checked) current.add(item.key);
        else current.delete(item.key);
        list.checked = [...current];
        saveList();
        row.classList.toggle('is-checked', checkbox.checked);
      });

      const meta = [];
      if (item.quantity) meta.push(el('span', { class: 'item-qty', text: item.quantity }));
      const reason = el('span', {
        class: `reason${item.reason === 'nearlyEmpty' ? ' is-empty' : ''}`,
        text: reasonLabel(item),
      });
      meta.push(reason);
      if (item.confidence === 'low') meta.push(el('span', { class: 'item-qty', text: 'low confidence' }));

      const remove = el('button', {
        class: 'item-delete',
        type: 'button',
        'aria-label': `Remove ${item.name} from the list`,
        title: 'Remove',
      });
      remove.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      remove.addEventListener('click', () => {
        state.list.items = state.list.items.filter((entry) => entry.key !== item.key);
        state.list.checked = state.list.checked.filter((key) => key !== item.key);
        saveList();
        renderListBody();
      });

      const label = el('label', { class: 'item-main', for: checkbox.id }, [
        el('span', { class: 'item-name', text: titleCase(item.name) }),
        el('span', { class: 'item-meta' }, meta),
      ]);

      const row = el('li', { class: `item${checked.has(item.key) ? ' is-checked' : ''}` }, [checkbox, label, remove]);
      items.push(row);
    }
    dom.listBody.append(
      el('div', { class: 'list-section' }, [
        el('h3', { text: `${group.label} · ${group.items.length}` }),
        el('ul', {}, items),
      ]),
    );
  }

  dom.listEmpty.hidden = groups.length > 0;
  renderListNote();
}

function renderListNote() {
  const list = state.list;
  const notes = [];
  if (list.alreadyHave.length) {
    const names = list.alreadyHave.slice(0, 8).map((entry) => titleCase(entry.name));
    const extra = list.alreadyHave.length - names.length;
    notes.push(`Already in the fridge, so left off: ${names.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}.`);
  } else {
    notes.push('None of your staples showed up clearly in the photos, which is why most of them are here.');
  }
  if (list.unknownStaples.length) {
    notes.push(`Compared against ${plural(state.staples.length, 'staple')}.`);
  }
  if (list.attempts > 1) {
    notes.push('The model needed a second try to give us clean JSON.');
  }
  if (list.stats?.dropped) {
    notes.push(`${plural(list.stats.dropped, 'entry', 'entries')} were dropped as empty or duplicated.`);
  }
  notes.push('Missing is a guess, not a fact. A photo cannot show what is gone.');
  dom.listNote.textContent = notes.join(' ');
}

function renderSeen(restored = false) {
  const list = state.list;
  dom.seenList.replaceChildren();
  const seen = Array.isArray(list.seen) ? list.seen : [];

  if (!seen.length) {
    dom.seenList.append(el('p', { class: 'card-sub', text: 'The model did not name anything it was sure about.' }));
  }

  for (const item of seen) {
    const confidence = hasConfidence(item) ? item.confidence : 'low';
    const low = confidence === 'low';
    const stapleMatch = state.staples.find((staple) => matchesStaple(staple, item.name));
    const notes = [];
    if (item.quantity) notes.push(el('p', { class: 'seen-qty', text: item.quantity }));
    if (item.nearlyEmpty) notes.push(el('p', { class: 'seen-flag', text: 'Looked nearly empty' }));
    if (stapleMatch && !item.nearlyEmpty) {
      notes.push(el('p', { class: 'seen-qty', text: `Matched your staple "${stapleMatch}" — left off the list` }));
    }
    dom.seenList.append(
      el('div', { class: `seen-item${low ? ' is-low' : ''}` }, [
        el('div', { class: 'seen-top' }, [
          el('span', { class: 'seen-name', text: titleCase(item.name) }),
          el('span', { class: `confidence ${confidence}`, text: `${confidence} confidence` }),
        ]),
        ...notes,
      ]),
    );
  }

  const unclear = Array.isArray(list.unclear) ? list.unclear : [];
  dom.unclearWrap.hidden = unclear.length === 0;
  dom.unclearList.replaceChildren();
  for (const note of unclear) dom.unclearList.append(el('li', { text: note }));

  const bits = [];
  bits.push(`${plural(seen.length, 'item')} reported`);
  if (list.stats?.received > seen.length) bits.push(`${list.stats.received} before cleaning`);
  if (list.stats?.dropped) bits.push(`${list.stats.dropped} dropped as duplicates or empty`);
  bits.push(`${plural(unclear.length, 'unclear note')}`);
  if (!restored && list.durationMs) bits.push(`${formatSeconds(list.durationMs)} round trip`);
  dom.seenStats.textContent = `Model report: ${bits.join(' · ')}.`;
  dom.seenSub.textContent = 'Verify it, then fix the list. Trust, but glance.';
}

/* ------------------------------------------------------------------ */
/* error card                                                          */
/* ------------------------------------------------------------------ */

const ERROR_TITLES = {
  ollama_unreachable: 'Ollama is not awake',
  model_missing: 'That model is not installed',
  timeout: 'That took too long',
  bad_json: 'The model mumbled',
  empty_reply: 'Ollama said nothing',
  ollama_bad_response: 'Ollama hiccuped',
  ollama_error: 'Ollama hiccuped',
  bad_response: 'Something got scrambled',
  bad_request: 'That request looked off',
  app_unreachable: 'The app server went quiet',
  server_error: 'Something broke on the server',
};

function hideError() {
  dom.errorCard.hidden = true;
}

function showError(error) {
  const code = error.code || 'error';
  dom.errorTitle.textContent = ERROR_TITLES[code] || 'That did not work';
  dom.errorMessage.textContent = error.message || 'Unknown problem.';
  dom.errorHint.textContent = error.hint || '';
  dom.errorHint.hidden = !error.hint;

  const commands = Array.isArray(error.commands) ? error.commands.filter(Boolean) : [];
  dom.errorCommandsWrap.hidden = commands.length === 0;
  dom.errorCommands.textContent = commands.join('\n');
  dom.errorCard.hidden = false;
  dom.errorCard.dataset.code = code;
  dom.errorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

dom.copyCommands.addEventListener('click', async () => {
  const ok = await copyText(dom.errorCommands.textContent);
  toast(ok ? 'Commands copied.' : 'Could not copy. Select the text instead.');
});

dom.retryButton.addEventListener('click', () => {
  hideError();
  handleAnalyze();
});

dom.errorSettingsButton.addEventListener('click', () => openSettings());

/* ------------------------------------------------------------------ */
/* analysis flow                                                       */
/* ------------------------------------------------------------------ */

function setBusy(busy) {
  state.analyzing = busy;
  dom.analyzeButton.disabled = busy || state.photos.length === 0;
  dom.analyzeButton.setAttribute('aria-busy', String(busy));
  dom.clearPhotosButton.disabled = busy;
  dom.photoInput.disabled = busy;
  dom.browseButton.disabled = busy;
  dom.stapleInput.disabled = busy;
  dom.itemInput.disabled = busy;
  dom.settingsButton.disabled = busy;
  dom.cancelButton.disabled = !busy;
}

async function handleAnalyze() {
  if (state.analyzing) return;
  if (!state.photos.length) {
    showPhotoError('Add at least one photo first.');
    return;
  }
  hideError();
  showPhotoError('');
  setBusy(true);
  startProgress();
  state.controller = new AbortController();
  const controller = state.controller;
  const clientTimeout = setTimeout(() => controller.abort('client-timeout'), CLIENT_TIMEOUT_MS);

  try {
    const data = await analyzePhotos({
      images: state.photos.map((photo) => photo.dataUrl),
      model: state.model || state.defaultModel,
      signal: controller.signal,
    });

    const fresh = diffStaples({ staples: state.staples, seen: data.items });
    state.list = {
      items: fresh.items,
      alreadyHave: fresh.alreadyHave,
      unknownStaples: fresh.unknownStaples,
      seen: data.items,
      unclear: data.unclear,
      checked: [],
      model: data.model,
      durationMs: data.durationMs,
      photoCount: state.photos.length,
      stats: data.stats,
      attempts: Array.isArray(data.attempts) ? data.attempts.length : 1,
      at: Date.now(),
    };
    saveList();
    renderResult();
    toast(
      fresh.items.length
        ? `${plural(fresh.items.length, 'item')} on the list, ${formatSeconds(data.durationMs)} well spent.`
        : `Nothing to buy. ${formatSeconds(data.durationMs)} to confirm you are all stocked up.`,
      { duration: 4200 },
    );
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    dom.resultCard.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  } catch (error) {
    if (error.name === 'AbortError' || controller.signal.aborted) {
      if (controller.signal.reason === 'client-timeout') {
        showError(
          new ApiError('The browser gave up waiting after 200 seconds.', {
            code: 'timeout',
            hint: 'The server keeps its own 180-second limit. If you see this, the machine is very busy — try one photo, or a smaller model.',
          }),
        );
      } else {
        toast('Stopped. No list made.');
      }
    } else {
      showError(error);
    }
  } finally {
    clearTimeout(clientTimeout);
    state.controller = null;
    stopProgress();
    setBusy(false);
  }
}

dom.analyzeButton.addEventListener('click', handleAnalyze);

dom.cancelButton.addEventListener('click', () => {
  state.controller?.abort('user');
});

/* ------------------------------------------------------------------ */
/* photos wiring                                                       */
/* ------------------------------------------------------------------ */

dom.browseButton.addEventListener('click', () => dom.photoInput.click());
dom.dropzone.addEventListener('click', (event) => {
  if (event.target === dom.photoInput || event.target.closest('button')) return;
  dom.photoInput.click();
});
dom.photoInput.addEventListener('change', async () => {
  await addFiles(dom.photoInput.files);
  dom.photoInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('is-dragging');
  });
}
dom.dropzone.addEventListener('drop', (event) => {
  addFiles(event.dataTransfer?.files);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

dom.clearPhotosButton.addEventListener('click', () => {
  state.photos = [];
  showPhotoError('');
  renderPhotos();
});

/* ------------------------------------------------------------------ */
/* staples wiring                                                      */
/* ------------------------------------------------------------------ */

dom.stapleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = dom.stapleInput.value;
  const name = cleanText(raw, 40);
  if (!name) return;
  const key = canonicalKey(name);
  if (state.staples.some((staple) => canonicalKey(staple) === key)) {
    toast(`"${titleCase(name)}" is already on your staples list.`);
    dom.stapleInput.value = '';
    return;
  }
  if (state.staples.length >= 60) {
    toast('That is plenty of staples. 60 is the cap.');
    return;
  }
  state.staples.push(name);
  saveStaples();
  dom.stapleInput.value = '';
  renderStaples();
  onStaplesChanged();
});

dom.resetStaples.addEventListener('click', () => {
  state.staples = [...DEFAULT_STAPLES];
  saveStaples();
  renderStaples();
  onStaplesChanged();
  toast('Staples reset to the default list.');
});

/* ------------------------------------------------------------------ */
/* list wiring                                                         */
/* ------------------------------------------------------------------ */

dom.itemForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.list) return;
  const name = cleanText(dom.itemInput.value, 48);
  if (!name) return;
  const key = canonicalKey(name);
  if (state.list.items.some((item) => item.key === key)) {
    toast(`"${titleCase(name)}" is already on the list.`);
    dom.itemInput.value = '';
    return;
  }
  if (state.list.items.length >= 60) {
    toast('The list is capped at 60 items. Honestly, that is enough shopping.');
    return;
  }
  state.list.items.push({
    key,
    name,
    section: classifySection(name),
    reason: 'manual',
    confidence: null,
    quantity: '',
  });
  dom.itemInput.value = '';
  saveList();
  renderListBody();
  toast('Added. Laziness respected.');
});

dom.copyButton.addEventListener('click', async () => {
  if (!state.list) return;
  const text = listToText(state.list.items, { checked: new Set(state.list.checked) });
  const ok = await copyText(text);
  toast(ok ? 'List copied as plain text.' : 'Copy failed. Try the download instead.');
});

dom.downloadButton.addEventListener('click', () => {
  if (!state.list) return;
  const text = listToText(state.list.items, { checked: new Set(state.list.checked) });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = el('a', { href: url, download: `fridge-to-list-${stamp}.txt` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded. Paper optional.');
});

dom.uncheckButton.addEventListener('click', () => {
  if (!state.list) return;
  state.list.checked = [];
  saveList();
  renderListBody();
  toast('All unchecked.');
});

dom.itemInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dom.itemInput.blur();
});

/* ------------------------------------------------------------------ */
/* seen panel                                                          */
/* ------------------------------------------------------------------ */

dom.seenToggle.addEventListener('click', () => {
  const expanded = dom.seenToggle.getAttribute('aria-expanded') === 'true';
  dom.seenToggle.setAttribute('aria-expanded', String(!expanded));
  dom.seenBody.hidden = expanded;
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function currentModel() {
  return state.model || state.defaultModel;
}

function updateModelChip() {
  const model = currentModel();
  dom.modelLabel.textContent = model;
  dom.modelDot.classList.remove('ok', 'warn');
  if (state.online === true) dom.modelDot.classList.add('ok');
  else if (state.online === false) dom.modelDot.classList.add('warn');
  dom.settingsButton.title =
    state.online === false
      ? 'Ollama is not reachable — open settings for setup steps'
      : `Model: ${model}. Click to change.`;
}

function renderSettingsStatus() {
  dom.ollamaDot.classList.remove('ok', 'warn');
  if (state.online === true) {
    dom.ollamaDot.classList.add('ok');
    const count = state.models.length;
    dom.ollamaStatusText.textContent = count
      ? `Ollama is running · ${plural(count, 'local model')} installed`
      : 'Ollama is running, but no models are installed yet.';
  } else if (state.online === false) {
    dom.ollamaDot.classList.add('warn');
    dom.ollamaStatusText.textContent = 'Ollama is not answering on this machine.';
  } else {
    dom.ollamaStatusText.textContent = 'Checking Ollama…';
  }
}

function renderModelSelect() {
  const selected = currentModel();
  dom.modelSelect.replaceChildren();
  const names = state.models.map((model) => model.name);

  if (!names.length) {
    dom.modelSelect.append(el('option', { value: selected, text: `${selected} (not installed)` }));
    dom.modelSelect.value = selected;
  } else {
    for (const model of state.models) {
      const bits = [model.name];
      if (model.parameterSize) bits.push(model.parameterSize);
      dom.modelSelect.append(el('option', { value: model.name, text: bits.join(' · ') }));
    }
    if (!names.includes(selected)) {
      dom.modelSelect.append(el('option', { value: selected, text: `${selected} (not installed)` }));
    }
    dom.modelSelect.value = selected;
  }

  if (state.online === false) {
    dom.modelHelp.textContent = 'Start Ollama first, then hit Refresh. Until then there is nothing to pick.';
  } else if (!names.length) {
    dom.modelHelp.textContent = 'No models yet. Run `ollama pull gemma3:4b` in a terminal, then hit Refresh.';
  } else if (!names.includes(selected)) {
    dom.modelHelp.textContent = `"${selected}" is not installed. Pick one from the list, or run ollama pull ${selected}.`;
  } else {
    dom.modelHelp.textContent = 'Any installed vision model works. gemma3:4b is the default: small, open-weight, quick enough on a laptop.';
  }
}

async function loadModels() {
  state.online = null;
  renderSettingsStatus();
  try {
    const data = await fetchModels();
    state.models = Array.isArray(data.models) ? data.models : [];
    state.defaultModel = data.defaultModel || state.defaultModel;
    state.online = true;
  } catch (error) {
    state.models = [];
    state.online = false;
    dom.modelHelp.textContent = error.message;
  }
  updateModelChip();
  renderSettingsStatus();
  renderModelSelect();
}

function openSettings() {
  loadModels();
  if (!dom.settingsDialog.open) dom.settingsDialog.showModal();
}

dom.settingsButton.addEventListener('click', openSettings);
dom.refreshModels.addEventListener('click', loadModels);

dom.saveSettings.addEventListener('click', (event) => {
  event.preventDefault();
  const value = cleanText(dom.modelSelect.value, 120);
  if (value) {
    state.model = value;
    writeStorage(STORAGE.model, value);
    updateModelChip();
    toast(`Using ${value}.`);
  }
  dom.settingsDialog.close();
});

dom.resetModel.addEventListener('click', () => {
  state.model = '';
  writeStorage(STORAGE.model, null);
  renderModelSelect();
  updateModelChip();
  toast(`Back to the default, ${state.defaultModel}.`);
});

dom.settingsDialog.addEventListener('close', () => {
  updateModelChip();
});

/* ------------------------------------------------------------------ */
/* demo                                                               */
/* ------------------------------------------------------------------ */

dom.demoButton.addEventListener('click', () => {
  if (!dom.demoDialog.open) dom.demoDialog.showModal();
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  renderPhotos();
  renderStaples();
  updateModelChip();
  renderSettingsStatus();

  if (state.list) {
    renderResult({ restored: true });
    dom.listNote.textContent = `${dom.listNote.textContent} Restored from this browser's saved list — rerun the photos for a fresh look.`;
  }

  loadModels();
  // A quiet background check so the model chip is honest without opening settings.
  dom.analyzeButton.disabled = true;
}

boot();
