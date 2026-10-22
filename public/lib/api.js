// Thin wrapper around our own server. Only same-origin requests; the browser
// never talks to Ollama directly (Ollama has no CORS story worth relying on).

export class ApiError extends Error {
  constructor(message, { code = 'error', hint = '', commands = [], status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.commands = commands;
    this.status = status;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchModels({ signal } = {}) {
  let response;
  try {
    response = await fetch('/api/models', { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('The app server is not answering.', {
      code: 'app_unreachable',
      hint: 'Is `npm run dev` still running in your terminal?',
    });
  }
  const payload = await readJson(response);
  if (!response.ok || !payload?.ok) {
    const detail = payload?.error || {};
    throw new ApiError(detail.message || `Could not list models (HTTP ${response.status}).`, {
      code: detail.code || 'models_failed',
      hint: detail.hint || '',
      commands: detail.commands || [],
      status: response.status,
    });
  }
  return payload;
}

export async function analyzePhotos({ images, model, signal }) {
  let response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ images, model }),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the Fridge to List server.', {
      code: 'app_unreachable',
      hint: 'Check the terminal running `npm run dev`.',
    });
  }
  const payload = await readJson(response);
  if (!payload) {
    throw new ApiError(`The server sent something unreadable (HTTP ${response.status}).`, {
      code: 'bad_response',
      hint: 'Try again. If it keeps happening, restart `npm run dev`.',
      status: response.status,
    });
  }
  if (!response.ok || !payload.ok) {
    const detail = payload.error || {};
    throw new ApiError(detail.message || 'The analysis failed.', {
      code: detail.code || 'error',
      hint: detail.hint || '',
      commands: detail.commands || [],
      status: response.status,
    });
  }
  return payload;
}
