# Fridge to List

**Snap your fridge. Go do nothing. Come back to a grocery list.**

Fridge to List is a local-first web app that reads one to four photos of your fridge, freezer or pantry and turns
them into an editable grocery list. The eyes doing the reading are an open-weight vision model — **Gemma 3
(`gemma3:4b`)** — running on your own machine through [Ollama](https://ollama.com). No cloud, no account, no API
key, no photos leaving the building.

Built for the **Hacktoberfest Open-Source AI Challenge, Week 3: "Slow and Steady"** — software that rewards
laziness, in the most literal way we could manage.

---

## What it does

1. **You add 1–4 photos** of fridge shelves, the door, or the pantry. They are resized in the browser and kept in
   memory only.
2. **A local vision model looks at them** and returns strict JSON: only items it can actually see, each with a
   rough quantity (`"about half a carton"`) and a confidence (`high` / `medium` / `low`). Anything it cannot
   identify goes into a **"could not tell"** list instead of being guessed.
3. **You keep a "usual staples" list** (milk, eggs, bread, onions, rice…) in `localStorage`. It is editable and
   lives only in your browser.
4. **The grocery list is the difference:** staples that did not appear in the photos, plus anything the model says
   looks nearly empty. It is grouped by store section, editable, check-off-able, copyable, and downloadable as
   `.txt`.
5. **You check the model's work.** A "what the model actually saw" panel shows every item with its confidence and
   highlights low-confidence guesses.
6. **You see the timing** in seconds. The whole point is how little you did, so we measure it.

### The honest bit (please read)

A photo shows what **is** in the fridge. It can never show what is **gone**. So "missing" here is an inference, not
an observation: we compare the things the model saw against the staples you told us you keep. That is why staples
are the backbone of the list, and why the UI says so out loud.

The app never invents placeholder results. If Ollama is not running or the model is not installed, you get a clear
error and the exact commands to fix it — not sample data dressed up as AI output. There is a **Sample preview**
button in the header, and it is labelled *"sample data, not AI"*, kept in its own dialog, and never mixed with real
results.

---

## Why open-weight, and why local

- **A grocery list is a private document.** It reveals what you eat, what you can afford, when you are home, and
  whether the fridge is empty. That data has no business being uploaded to a subscription service to generate a
  shopping list.
- **The job is small.** Reading labels and counting eggs does not need a frontier model. A 4-billion-parameter
  open-weight model can do a useful job of it on a laptop, and can be run by anyone, for free, forever.
- **Open weights mean inspectable, swappable AI.** The model is a file you download, not an endpoint someone can
  change or retire. The prompt and schema are in [`lib/prompt.js`](lib/prompt.js). Any installed Ollama vision model
  can be selected in Settings — the default is just the one that fits comfortably on modest hardware.
- **Local-first is a feature, not a limitation.** Once the model is pulled, the app works offline. Nothing here
  calls out to a CDN, a font server, or an analytics endpoint. Check the CSP header in `server.js`: it is `'self'`
  all the way down.

---

## Setup

### 1. Install Node.js 22 or newer

```bash
node -v    # should print v22.x or higher
```

If not, install it from [nodejs.org](https://nodejs.org) or with your version manager of choice.

### 2. Install Ollama and pull the model

Install Ollama from [ollama.com/download](https://ollama.com/download), then:

```bash
ollama serve          # usually already running in the background
ollama pull gemma3:4b # about 3.3 GB — the only large download
```

Check that it worked:

```bash
ollama list           # gemma3:4b should be listed
```

### 3. Run Fridge to List

```bash
npm ci
npm run dev
```

Then open **<http://localhost:3000>**.

That is it. No `.env` file, no database, no build step. The UI is plain HTML, CSS and ES modules.

> **First run is slow.** Ollama loads the model into memory the first time you ask it something, which can take a
> while (and more so on a laptop without a GPU). The app shows a live timer and keeps waiting for up to 180 seconds.
> Sub­sequent runs are much quicker. This is the "slow and steady" part, and we are not going to pretend otherwise.

---

## Configuration

Everything has a sensible default. These environment variables are optional:

| Variable             | Default                  | What it does                                             |
| -------------------- | ------------------------ | -------------------------------------------------------- |
| `PORT`               | `3000`                   | Port the app listens on                                  |
| `HOST`               | `0.0.0.0`                | Bind address                                             |
| `OLLAMA_URL`         | `http://localhost:11434` | Where your local Ollama server lives                     |
| `OLLAMA_MODEL`       | `gemma3:4b`              | Default model; can also be changed in the Settings panel |
| `OLLAMA_TIMEOUT_MS`  | `180000`                 | How long to wait for inference before giving up          |

Example:

```bash
OLLAMA_MODEL=gemma3:12b npm run dev
```

Any locally installed Ollama model can be picked in **Settings** (the panel reads `/api/tags`). The default was
chosen to run on ordinary laptops; a larger Gemma 3 will generally read labels better if you have the RAM.

---

## How it works

```
photos (browser)                  server (Node)                     Ollama (your machine)
   │                                  │                                   │
   ├─ resize to ≤1024px JPEG ────────►│                                   │
   │  (never written to disk)         ├─ GET /api/tags (is it installed?) ►│
   │                                  ├─ POST /api/chat + base64 photos ──►│  gemma3:4b
   │                                  │◄──────────── JSON text ────────────┤
   │                                  ├─ parse, trim, de-dupe, cap         │
   │                                  ├─ retry once if the JSON is bad     │
   │◄── validated items + timing ─────┤                                   │
   │                                  │                                   │
   ├─ staples diff in the browser ────┘                                   │
   └─ editable checklist (localStorage)
```

**Stage 1, vision.** The model is asked for one strict shape:

```json
{
  "items": [
    {
      "name": "milk",
      "quantity": "about half a carton",
      "confidence": "high",
      "nearlyEmpty": true,
      "section": "dairy"
    }
  ],
  "unclear": ["blurry jar on the bottom shelf, label turned away"]
}
```

The prompt says *never invent items*, and unclear things must go in `unclear` rather than be named.

**Validation, in code.** Prompts are requests, not guarantees, so the guardrails live in
[`lib/parse.js`](lib/parse.js) and [`public/lib/staples.js`](public/lib/staples.js):

- JSON is extracted even if the model wraps it in prose or markdown fences, or adds trailing commas / smart quotes.
- Names are trimmed, stripped of bullets and quotes, and length-capped; empty names are dropped.
- Duplicates are merged using a normalized key (case, punctuation, plurals, common synonyms: *yoghurt → yogurt*,
  *capsicum → bell pepper*, *scallions → green onion*).
- Confidence is coerced to `high` / `medium` / `low`; unknown values become `low`, not a confident guess.
- Lists are capped (40 items from the model, 60 on the final list, 8 "could not tell" notes).
- If the reply cannot be read as JSON, the request is retried **once** with a stricter instruction; if it fails
  again you get a readable error that includes the start of what the model actually said.
- Sections are assigned by a deterministic keyword table first, with the model's suggestion only as a fallback.

**The staples diff.** `diffStaples()` is intentionally dumb and predictable:

| Item                         | Result                                          |
| ---------------------------- | ----------------------------------------------- |
| Staple seen and looks full   | Not on the list; shown as "already in the fridge" |
| Staple seen but nearly empty | On the list: *looks nearly empty*               |
| Staple not seen at all       | On the list: *not seen in photos*               |
| Non-staple, nearly empty     | On the list: *looks nearly empty*               |
| Anything you add by hand     | On the list: *added by you*                     |

Matching is careful about different products: `oat milk` does not satisfy a `milk` staple, `spring onions` do not
satisfy `onions`, and `tomato sauce` does not satisfy `tomatoes`.

---

## Tests

```bash
npm test
```

Runs the Node test runner (`node --test`), no extra dependencies. 33 tests cover:

- JSON extraction from fenced / chatty / slightly broken model replies
- validation: trimming, de-duplication, confidence coercion, caps, unclear notes
- request validation: photo count, MIME types, base64, model names
- staples diffing: missing / nearly-empty / manual items, synonyms and false-positive guards
- section classification and plain-text export

---

## Honest limitations

- **A 4B model misidentifies things.** It may call a jar of pickles "relish", mistake a tub of hummus for butter, or
  miss small items at the back of a shelf. That is why the "what the model saw" panel exists — glance at it before
  shopping.
- **"Missing" is inferred, not seen.** An empty shelf where milk usually sits looks exactly like a shelf where milk
  never sits. The staples list is what makes the guess possible; keep it accurate.
- **Photos are only as good as the light.** Dark shelves, glare on jars, and labels facing away all reduce accuracy.
  The model is instructed to put those things under "could not tell", but it does not always comply.
- **No object detection, no counting precision.** Quantities like "about half a carton" are the model's impression,
  not a measurement. It cannot see inside a closed box.
- **It handles fridges and pantries, not receipts.** Photographing a shopping list or a supermarket shelf will
  probably produce nonsense, and we ask the model to say so.
- **CPU-only machines are slow.** Expect tens of seconds to a couple of minutes per run on integrated graphics;
  Apple Silicon or a GPU is much faster. The app's 180s timeout is there to keep a hung request from hanging you.
- **No accounts, sync, or history.** The list is saved in this browser's `localStorage` so a refresh does not lose
  it, and that is the entire persistence story. Clearing site data clears the list.
- **It does not know prices, recipes, or nutrition.** Out of scope, on purpose.

---

## Privacy

- Photos are read in the browser, downscaled to at most 1024px, and sent only to the local Fridge to List server
  running on your machine, which forwards them to your local Ollama instance.
- Photos are held in memory for the duration of the request. They are not written to disk, not logged, and not
  stored in `localStorage`.
- Nothing is sent to any third party. There are no fonts, scripts, images or analytics loaded from a CDN or remote
  host; the Content-Security-Policy header enforces this.
- The staples list and the last generated list are stored in your browser's `localStorage` only. The "clear photos"
  button clears the in-memory copies.

If you run the server with `HOST=0.0.0.0` and open it from another device on your network, the photos go to the
machine running the server — not to the device taking the picture. Keep it on localhost if that matters to you.

---

## Project layout

```
fridge-to-list/
├── server.js              # Express server, static files, /api/models and /api/analyze
├── lib/
│   ├── ollama.js          # Ollama client: model check, chat call, retry, timeouts
│   ├── parse.js           # JSON extraction + validation guardrails
│   └── prompt.js          # the vision prompt and the JSON shape
├── public/
│   ├── index.html         # the whole UI
│   ├── styles.css         # calm, local, no external fonts
│   ├── app.js             # UI state, photo resizing, list editing, settings
│   └── lib/
│       ├── normalize.js   # text normalization (shared with tests)
│       ├── staples.js     # staples diff, sections, plain-text export
│       └── api.js         # same-origin fetch wrappers
└── test/                  # node --test unit tests
```

The `public/lib` modules are imported directly by Node in tests and by the browser at runtime, so the shopping
logic cannot silently drift from the tested logic.

---

## Hacktoberfest

This project is open source under the MIT license and welcomes issues and pull requests. If you are here from the
Open-Source AI Challenge: the "lazy payoff" is real but modest — a handful of photos turn into a list without
typing, and the app shows you the exact number of seconds the model spent earning it.

Some honest ideas if you want to contribute:

- Better section heuristics for regional groceries (the keyword table is `SECTION_RULES` in `public/lib/staples.js`).
- More synonyms in the alias table, especially non-English product names.
- Accessibility improvements, larger-model prompt variants, and additional tests for messy model output.

Please keep the scope: no accounts, no databases, no cloud services, no fake AI output.

## License

MIT. See [LICENSE](LICENSE).
