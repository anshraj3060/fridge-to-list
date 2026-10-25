// The vision prompt. Kept short and boring on purpose: 4B models do better with
// a small schema and a couple of blunt rules than with a long essay.

export const SYSTEM_PROMPT = [
  'You are a careful kitchen assistant reading photos of a fridge or pantry.',
  'You only report food and containers you can actually see. You never guess and you never invent items.',
  'You always answer with a single JSON object and nothing else.',
].join(' ');

export const JSON_SCHEMA_HINT = `{
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
}`;

export const USER_PROMPT = `Look at these photos of a fridge or pantry and list what you can actually see.

Answer with ONLY this JSON object. No markdown, no explanation, no code fences.

${JSON_SCHEMA_HINT}

Rules:
- name: a short common grocery name, 1-3 words, lowercase ("milk", "eggs", "red onion").
- quantity: a rough visible amount in a few words ("about half a carton", "2 left", "looks full", "unopened").
- confidence: "high" if you are sure, "medium" if fairly sure, "low" if unsure.
- nearlyEmpty: true only when that container or packet looks almost used up. Otherwise false.
- section: one of "produce", "dairy", "bakery", "pantry", "meat", "frozen", "drinks", "household", "other".
- If the same item appears in more than one photo, list it once.
- If you cannot identify something, do NOT name a product. Describe it in "unclear" instead ("green bottle, label hidden").
- Maximum 25 items and 5 unclear notes.
- If the photos do not show food or containers at all, return {"items": [], "unclear": ["this does not look like a fridge or pantry"]}.

JSON only.`;

export const RETRY_PROMPT = `Your previous answer could not be read as the required JSON object.
Reply again with valid JSON only, using exactly the schema above: an "items" array and an "unclear" array. No markdown, no commentary.`;
