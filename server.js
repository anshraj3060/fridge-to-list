// Fridge to List — a tiny local server. No database, no accounts, no cloud.
//
//   npm run dev   →  http://localhost:3000
//
// The only outbound request this process ever makes is to the Ollama server on
// the same machine (OLLAMA_URL, default http://localhost:11434).

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  OllamaError,
  analyzePhotos,
  listModels,
} from './lib/ollama.js';
import { validateAnalyzeRequest } from './lib/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));

// No external fonts, scripts or images at runtime: everything ships from here.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self' https: http:",
    ].join('; '),
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    maxAge: 0,
    etag: true,
  }),
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: DEFAULT_MODEL,
    ollamaUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
});

app.get('/api/models', async (req, res) => {
  try {
    const result = await listModels({ baseUrl: DEFAULT_BASE_URL });
    res.json({
      ok: true,
      baseUrl: result.baseUrl,
      defaultModel: DEFAULT_MODEL,
      models: result.models,
      setup: { commands: ['ollama serve', `ollama pull ${DEFAULT_MODEL}`] },
    });
  } catch (error) {
    sendOllamaError(res, error);
  }
});

app.post('/api/analyze', async (req, res) => {
  const started = Date.now();
  let request;
  try {
    request = validateAnalyzeRequest(req.body, { defaultModel: DEFAULT_MODEL });
  } catch (error) {
    res.status(error.status || 400).json({
      ok: false,
      error: { code: 'bad_request', message: error.message, hint: '', commands: [] },
    });
    return;
  }

  try {
    const result = await analyzePhotos({
      baseUrl: DEFAULT_BASE_URL,
      model: request.model,
      images: request.images,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    console.log(
      `[fridge-to-list] looked at ${request.images.length} photo(s) with ${result.model} ` +
        `in ${(result.durationMs / 1000).toFixed(1)}s — ${result.items.length} item(s), ` +
        `${result.unclear.length} unclear`,
    );
    res.json({ ok: true, ...result, elapsedMs: Date.now() - started });
  } catch (error) {
    sendOllamaError(res, error);
  }
});

function sendOllamaError(res, error) {
  if (error instanceof OllamaError) {
    if (error.code !== 'model_missing') {
      console.warn(`[fridge-to-list] ${error.code}: ${error.message}`);
    }
    res.status(error.status || 500).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        hint: error.hint || '',
        commands: error.commands || [],
        model: error.model || null,
      },
    });
    return;
  }
  console.error('[fridge-to-list] unexpected error:', error);
  res.status(500).json({
    ok: false,
    error: {
      code: 'server_error',
      message: 'Something went wrong on the server.',
      hint: String(error?.message || error).slice(0, 300),
      commands: [],
    },
  });
}

// Fallback for client-side routes: there are none, so a plain 404 page.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'No such endpoint.', commands: [] } });
    return;
  }
  res.status(404).type('text/plain').send('Not here. Try http://localhost:3000');
});

// Malformed or oversized request bodies never reached a route.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const tooLarge = err.type === 'entity.too.large';
  res.status(status).json({
    ok: false,
    error: {
      code: 'bad_request',
      message: tooLarge ? 'Those photos are too large together.' : 'The request could not be read.',
      hint: tooLarge ? 'Try fewer photos, or smaller ones.' : 'Reload the page and try again.',
      commands: [],
    },
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Fridge to List is awake (barely).');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Ollama: ${DEFAULT_BASE_URL}`);
  console.log(`  → Model:  ${DEFAULT_MODEL}`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
