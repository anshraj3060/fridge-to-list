// Everything that talks to a local Ollama server. No cloud, no keys.
// fetch is global in Node 22, so this file has no dependencies.

import { ParseError, parseModelResponse } from './parse.js';
import { JSON_SCHEMA_HINT, RETRY_PROMPT, SYSTEM_PROMPT, USER_PROMPT } from './prompt.js';

export const DEFAULT_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
export const DEFAULT_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 180_000);

export const SETUP_COMMANDS = [
  'ollama serve',
  `ollama pull ${DEFAULT_MODEL}`,
];

export class OllamaError extends Error {
  constructor(code, message, { hint = '', status = 500, commands = [], model = null, cause = null } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.commands = commands;
    this.model = model;
    if (cause) this.cause = cause;
  }
}

function trimBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function request(url, { method = 'GET', body, timeoutMs = 10_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function unreachableError(baseUrl, cause) {
  return new OllamaError(
    'ollama_unreachable',
    `Could not reach Ollama at ${baseUrl}.`,
    {
      status: 503,
      hint: 'Ollama needs to be running on this machine before we can look at photos.',
      commands: SETUP_COMMANDS,
      cause,
    },
  );
}

function modelMissingError(baseUrl, model, installed) {
  return new OllamaError(
    'model_missing',
    `Ollama is running, but the model "${model}" is not installed.`,
    {
      status: 400,
      hint: installed.length
        ? `Installed right now: ${installed.join(', ')}. Pull the model below, or pick an installed one in Settings.`
        : 'No models are installed yet. Pull one below.',
      commands: [`ollama pull ${model}`],
      model,
    },
  );
}

function timeoutError(model, timeoutMs) {
  return new OllamaError(
    'timeout',
    `The model was still thinking after ${Math.round(timeoutMs / 1000)} seconds, so we stopped it.`,
    {
      status: 504,
      hint: 'Small laptops can be slow with photos. Try one photo at a time, a smaller model, or raise OLLAMA_TIMEOUT_MS.',
      model,
    },
  );
}

/** List locally installed models via /api/tags. */
export async function listModels({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 5_000, signal } = {}) {
  const base = trimBaseUrl(baseUrl);
  let response;
  try {
    response = await request(`${base}/api/tags`, { timeoutMs, signal });
  } catch (cause) {
    throw unreachableError(base, cause);
  }
  if (!response.ok) {
    throw new OllamaError('ollama_bad_response', `Ollama answered /api/tags with HTTP ${response.status}.`, {
      status: 502,
      hint: 'Check that OLLAMA_URL points at a real Ollama server.',
      cause: await response.text().catch(() => ''),
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new OllamaError('ollama_bad_response', 'Ollama sent something that was not JSON.', {
      status: 502,
      cause,
    });
  }
  const models = (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
    name: model.name || model.model,
    family: model.details?.family || null,
    parameterSize: model.details?.parameter_size || null,
    quantization: model.details?.quantization_level || null,
    sizeBytes: typeof model.size === 'number' ? model.size : null,
    modifiedAt: model.modified_at || null,
  })).filter((model) => typeof model.name === 'string' && model.name);
  return { baseUrl: base, models };
}

/** Model names from Ollama include a tag; be forgiving about ":latest". */
export function isModelInstalled(model, installedNames) {
  if (!model) return false;
  const wanted = String(model).trim();
  return installedNames.some((name) => {
    if (name === wanted) return true;
    const stripTag = (value) => value.replace(/:latest$/, '');
    return stripTag(name) === stripTag(wanted);
  });
}

/**
 * One chat completion with photos. Returns the raw assistant text.
 */
async function chat({ baseUrl, model, messages, timeoutMs, temperature }) {
  let response;
  try {
    response = await request(`${trimBaseUrl(baseUrl)}/api/chat`, {
      method: 'POST',
      timeoutMs,
      body: {
        model,
        stream: false,
        format: 'json',
        messages,
        options: { temperature, num_predict: 900, num_ctx: 8192 },
      },
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw timeoutError(model, timeoutMs);
    throw unreachableError(trimBaseUrl(baseUrl), cause);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      message = JSON.parse(text)?.error || text;
    } catch {
      /* keep raw text */
    }
    if (response.status === 404) {
      throw new OllamaError('model_missing', `Ollama does not have the model "${model}".`, {
        status: 400,
        hint: message || 'Pull the model first.',
        commands: [`ollama pull ${model}`],
        model,
      });
    }
    throw new OllamaError('ollama_error', `Ollama returned HTTP ${response.status}.`, {
      status: 502,
      hint: String(message || '').slice(0, 400),
      model,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new OllamaError('ollama_bad_response', 'Ollama sent a reply that was not JSON.', {
      status: 502,
      model,
      cause,
    });
  }
  const content = payload?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new OllamaError('empty_reply', 'Ollama replied with nothing at all.', {
      status: 502,
      hint: 'That happens now and then. Trying again usually helps.',
      model,
    });
  }
  return content;
}

/**
 * The whole stage-1 flow: preflight the model, ask the vision model, validate
 * the JSON, and retry exactly once if the reply was unreadable.
 */
export async function analyzePhotos({
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  images,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new OllamaError('bad_request', 'No photos were sent.', { status: 400 });
  }
  const startedAt = Date.now();
  const { models } = await listModels({ baseUrl, timeoutMs: Math.min(timeoutMs, 10_000) });
  const installedNames = models.map((entry) => entry.name);
  if (!isModelInstalled(model, installedNames)) {
    throw modelMissingError(trimBaseUrl(baseUrl), model, installedNames);
  }

  const baseMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: USER_PROMPT,
      images: images.map((image) => image.base64),
    },
  ];

  const attempts = [];
  let parsed = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const messages = attempt === 1
      ? baseMessages
      : [...baseMessages, { role: 'user', content: RETRY_PROMPT }];
    const attemptStart = Date.now();
    let content;
    try {
      content = await chat({
        baseUrl,
        model,
        messages,
        timeoutMs,
        temperature: attempt === 1 ? 0.2 : 0,
      });
    } catch (error) {
      attempts.push({ attempt, ms: Date.now() - attemptStart, ok: false, reason: error.code || 'error' });
      throw error;
    }
    try {
      parsed = parseModelResponse(content);
      attempts.push({ attempt, ms: Date.now() - attemptStart, ok: true });
      break;
    } catch (error) {
      lastError = error;
      attempts.push({ attempt, ms: Date.now() - attemptStart, ok: false, reason: error.message });
      if (!(error instanceof ParseError)) throw error;
      logger.warn?.(`[fridge-to-list] attempt ${attempt} returned unreadable JSON: ${error.message}`);
    }
  }

  if (!parsed) {
    throw new OllamaError(
      'bad_json',
      'The model replied twice with something we could not read as JSON.',
      {
        status: 502,
        hint: lastError?.snippet
          ? `Last reply started with: "${lastError.snippet.slice(0, 140)}…"`
          : 'Try again, or try a slightly larger model.',
        model,
      },
    );
  }

  const durationMs = Date.now() - startedAt;
  return {
    itemCount: parsed.items.length,
    items: parsed.items,
    unclear: parsed.unclear,
    stats: parsed.stats,
    model,
    baseUrl: trimBaseUrl(baseUrl),
    attempts,
    durationMs,
    schemaHint: JSON_SCHEMA_HINT,
  };
}
