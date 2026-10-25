// Turn whatever the model said into a small, validated object.
// All the guardrails live here, not in the prompt: trim, de-dupe, cap, coerce.

import { cleanText, normalizeKey } from '../public/lib/normalize.js';
import { normalizeSection } from '../public/lib/staples.js';

export const DEFAULT_LIMITS = {
  items: 40,
  unclear: 8,
  nameLength: 48,
  quantityLength: 60,
  noteLength: 120,
};

export class ParseError extends Error {
  constructor(message, { snippet = '' } = {}) {
    super(message);
    this.name = 'ParseError';
    this.snippet = snippet;
  }
}

const ITEM_KEYS = ['items', 'groceries', 'found', 'visible', 'seen', 'ingredients', 'products'];
const UNCLEAR_KEYS = [
  'unclear', 'couldNotTell', 'could_not_tell', 'unsure', 'unknown', 'unidentified', 'uncertain',
];

const CONFIDENCE_MAP = {
  high: 'high',
  sure: 'high',
  certain: 'high',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  fair: 'medium',
  low: 'low',
  unsure: 'low',
  uncertain: 'low',
  unknown: 'low',
};

function repairJson(text) {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

function tryParse(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the repaired attempt */
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return undefined;
  }
}

/** Return the balanced {...} or [...] block that starts at `start`. */
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull JSON out of a model reply that may contain markdown fences or a chatty
 * preamble. Returns the first parseable object/array, or undefined.
 */
export function extractJson(raw) {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return undefined;

  const unfenced = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  const direct = tryParse(unfenced);
  if (direct !== undefined) return direct;

  const starts = [];
  for (let i = 0; i < unfenced.length; i += 1) {
    const ch = unfenced[i];
    if (ch === '{' || ch === '[') starts.push(i);
    if (starts.length >= 8) break;
  }
  for (const start of starts) {
    const block = sliceBalanced(unfenced, start);
    if (!block) continue;
    const parsed = tryParse(block);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function coerceName(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    for (const key of ['name', 'item', 'label', 'product', 'description']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return '';
}

function coerceQuantity(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return `about ${value}`;
  if (typeof value === 'object') {
    for (const key of ['quantity', 'amount', 'estimate', 'qty', 'visible']) {
      const inner = coerceQuantity(value[key]);
      if (inner) return inner;
    }
  }
  return '';
}

function coerceConfidence(value) {
  if (typeof value !== 'string') return 'low';
  return CONFIDENCE_MAP[value.trim().toLowerCase()] || 'low';
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'nearly empty', 'almost empty', 'low', 'running low'].includes(v)) return true;
  }
  return false;
}

function coerceNearlyEmpty(raw) {
  const keys = [
    'nearlyEmpty', 'nearly_empty', 'nearlyempty', 'almostEmpty', 'almost_empty',
    'runningLow', 'running_low', 'low', 'status',
  ];
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === 'string' && /^(full|plenty|fine|ok|okay|new)$/i.test(value.trim())) return false;
    if (coerceBoolean(value)) return true;
  }
  return false;
}

function coerceSection(raw) {
  const candidate = raw.section ?? raw.category ?? raw.aisle ?? raw.storeSection;
  return normalizeSection(candidate) || null;
}

function normalizeItem(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const name = cleanText(raw, DEFAULT_LIMITS.nameLength);
    if (!name) return null;
    return {
      name,
      quantity: '',
      confidence: 'low',
      nearlyEmpty: false,
      section: null,
    };
  }
  if (typeof raw !== 'object') return null;
  const name = cleanText(coerceName(raw), DEFAULT_LIMITS.nameLength);
  if (!name) return null;
  return {
    name,
    quantity: cleanText(coerceQuantity(raw), DEFAULT_LIMITS.quantityLength),
    confidence: coerceConfidence(raw.confidence ?? raw.certainty ?? raw.sureness),
    nearlyEmpty: coerceNearlyEmpty(raw),
    section: coerceSection(raw),
  };
}

function confidenceStrength(confidence) {
  return { high: 3, medium: 2, low: 1 }[confidence] || 0;
}

/**
 * Validate and normalize a parsed model payload.
 * @throws {ParseError} when the reply is not usable JSON in the expected shape.
 */
export function parseModelResponse(raw, { limits = DEFAULT_LIMITS } = {}) {
  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  if (data === undefined || data === null) {
    throw new ParseError('The model did not reply with JSON we could read.', {
      snippet: typeof raw === 'string' ? raw.slice(0, 200) : '',
    });
  }

  let itemSource = null;
  let unclearSource = [];
  if (Array.isArray(data)) {
    itemSource = data;
  } else if (typeof data === 'object') {
    const itemKey = ITEM_KEYS.find((key) => Array.isArray(data[key]));
    const unclearKey = UNCLEAR_KEYS.find((key) => Array.isArray(data[key]));
    if (!itemKey && !unclearKey) {
      throw new ParseError('The model returned JSON, but with no "items" list in it.', {
        snippet: JSON.stringify(data).slice(0, 200),
      });
    }
    itemSource = itemKey ? data[itemKey] : [];
    unclearSource = unclearKey ? data[unclearKey] : [];
  } else {
    throw new ParseError('The model returned JSON, but not an object.', {
      snippet: String(data).slice(0, 200),
    });
  }

  const deduped = new Map();
  let droppedItems = 0;
  for (const candidate of itemSource) {
    const item = normalizeItem(candidate);
    if (!item) {
      droppedItems += 1;
      continue;
    }
    const key = normalizeKey(item.name);
    if (!key) {
      droppedItems += 1;
      continue;
    }
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }
    // Same item seen twice (two photos, or the model repeating itself): merge.
    if (item.quantity.length > existing.quantity.length) existing.quantity = item.quantity;
    existing.nearlyEmpty = existing.nearlyEmpty || item.nearlyEmpty;
    if (confidenceStrength(item.confidence) > confidenceStrength(existing.confidence)) {
      existing.confidence = item.confidence;
    }
    existing.section = existing.section || item.section;
  }

  let items = [...deduped.values()];
  if (items.length > limits.items) items = items.slice(0, limits.items);

  const seenNotes = new Set();
  const unclear = [];
  for (const entry of unclearSource) {
    const text = cleanText(coerceName(entry) || coerceQuantity(entry), limits.noteLength);
    if (!text) continue;
    const key = normalizeKey(text);
    if (!key || seenNotes.has(key)) continue;
    seenNotes.add(key);
    unclear.push(text);
    if (unclear.length >= limits.unclear) break;
  }

  return {
    items,
    unclear,
    stats: {
      received: itemSource.length,
      kept: items.length,
      dropped: droppedItems,
      truncated: items.length >= limits.items && itemSource.length > limits.items,
      unclear: unclear.length,
    },
  };
}

/** Parse a data URL or raw base64 photo, returning raw base64 and mime type. */
export function decodePhoto(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let base64 = value;
  let mime = 'image/jpeg';
  const dataUrl = /^data:([\w/+.-]+);base64,(.+)$/s.exec(value.trim());
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase();
    base64 = dataUrl[2];
  }
  base64 = base64.replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  if (base64.length < 64) return null;
  return { base64, mime };
}

/**
 * Validate the /api/analyze request body.
 * @returns {{images: {base64: string, mime: string}[], model: string|null}}
 */
export function validateAnalyzeRequest(body, { maxImages = 4, maxBytes = 8 * 1024 * 1024, defaultModel = null } = {}) {
  const fail = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  if (!body || typeof body !== 'object') fail('Send some photos to look at.');
  const rawImages = body.images;
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    fail('Add at least one photo of your fridge or pantry.');
  }
  if (rawImages.length > maxImages) fail(`That is ${rawImages.length} photos. Four is the most we can read at once.`);

  const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
  const images = [];
  for (const raw of rawImages) {
    const decoded = decodePhoto(typeof raw === 'string' ? raw : raw?.data);
    if (!decoded) fail('One of those photos could not be read. Try a JPEG, PNG or WebP image.');
    if (!allowed.has(decoded.mime)) fail(`${decoded.mime} images are not supported. Try JPEG, PNG or WebP.`);
    if (decoded.base64.length > maxBytes) fail('One of those photos is too large to send. Try a smaller image.');
    images.push(decoded);
  }

  let model = body.model;
  if (model !== undefined && model !== null && model !== '') {
    if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) fail('That model name does not look right.');
  } else {
    model = null;
  }
  return { images, model: model || defaultModel };
}
