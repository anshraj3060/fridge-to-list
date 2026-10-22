// Staples + diffing logic. Shared by the browser UI and the Node tests.
//
// Honesty note that shapes this module: a photo shows what *is* in the fridge.
// It can never show what is missing. So the "buy" list is built by comparing
// the things the model actually saw against the user's own staples list.

import { cleanText, normalizeKey, titleCase } from './normalize.js';

export const DEFAULT_STAPLES = [
  'milk',
  'eggs',
  'bread',
  'onions',
  'rice',
  'yogurt',
  'garlic',
  'tomatoes',
];

export const SECTION_ORDER = [
  'produce',
  'dairy',
  'bakery',
  'pantry',
  'meat',
  'frozen',
  'drinks',
  'household',
  'other',
];

export const SECTION_LABELS = {
  produce: 'Produce',
  dairy: 'Dairy & eggs',
  bakery: 'Bakery',
  pantry: 'Pantry',
  meat: 'Meat & fish',
  frozen: 'Frozen',
  drinks: 'Drinks',
  household: 'Household',
  other: 'Other',
};

/** Synonyms: alias -> canonical name. Keys and values are normalizeKey()'d. */
const ALIAS_SOURCE = {
  egg: 'egg',
  eggs: 'egg',
  yoghurt: 'yogurt',
  curd: 'yogurt',
  'greek yogurt': 'yogurt',
  'greek yoghurt': 'yogurt',
  capsicum: 'bell pepper',
  'red pepper': 'bell pepper',
  'green pepper': 'bell pepper',
  courgette: 'zucchini',
  aubergine: 'eggplant',
  'spring onion': 'green onion',
  scallion: 'green onion',
  'spring onions': 'green onion',
  coriander: 'cilantro',
  rocket: 'arugula',
  'prawn': 'shrimp',
  'prawns': 'shrimp',
  'minced meat': 'mince',
  'ground beef': 'mince',
  'loaf of bread': 'bread',
  'sliced bread': 'bread',
  'whole milk': 'milk',
  'semi skimmed milk': 'milk',
  'skim milk': 'milk',
  'oat milk': 'oat milk',
  'almond milk': 'almond milk',
  'soy milk': 'soy milk',
  'cooking oil': 'oil',
  'olive oil': 'olive oil',
  'toilet roll': 'toilet paper',
  'kitchen roll': 'paper towel',
  'cling film': 'plastic wrap',
  'garbage bag': 'trash bag',
  'bin bag': 'trash bag',
  'dish soap': 'dish soap',
  'washing up liquid': 'dish soap',
  'fizzy drink': 'soda',
  'soft drink': 'soda',
};

export const ALIASES = Object.fromEntries(
  Object.entries(ALIAS_SOURCE).map(([alias, canonical]) => [
    normalizeKey(alias),
    normalizeKey(canonical),
  ]),
);

/** Canonical match key: normalizes, singularizes, then folds aliases. */
export function canonicalKey(name) {
  const key = normalizeKey(name);
  if (!key) return '';
  if (ALIASES[key]) return ALIASES[key];
  // Also fold single-word synonyms inside longer names ("greek yoghurt").
  const mapped = key
    .split(' ')
    .map((word) => ALIASES[word] || word)
    .join(' ');
  return ALIASES[mapped] || mapped;
}

const SECTION_RULES = {
  produce: [
    'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'strawberry', 'blueberry',
    'raspberry', 'berry', 'avocado', 'tomato', 'cherry tomato', 'onion', 'green onion',
    'garlic', 'potato', 'sweet potato', 'carrot', 'cucumber', 'zucchini', 'eggplant',
    'bell pepper', 'chilli', 'chili', 'broccoli', 'cauliflower', 'cabbage', 'lettuce',
    'spinach', 'kale', 'arugula', 'celery', 'mushroom', 'ginger', 'cilantro', 'parsley',
    'basil', 'mint', 'dill', 'thyme', 'rosemary', 'corn', 'green bean', 'pea', 'sprout',
    'leek', 'beet', 'radish', 'turnip', 'squash', 'pumpkin', 'pear', 'peach', 'plum',
    'mango', 'melon', 'watermelon', 'pineapple', 'kiwi', 'papaya', 'pomegranate',
    'herb', 'salad', 'fruit', 'vegetable',
  ],
  dairy: [
    'milk', 'egg', 'cheese', 'yogurt', 'butter', 'cream', 'sour cream', 'paneer', 'tofu',
    'kefir', 'buttermilk', 'mozzarella', 'cheddar', 'parmesan', 'feta', 'cream cheese',
    'cottage cheese', 'margarine', 'ghee',
  ],
  bakery: [
    'bread', 'bagel', 'baguette', 'tortilla', 'pita', 'bun', 'roll', 'croissant',
    'muffin', 'naan', 'sourdough', 'ciabatta', 'brioche', 'wrap',
  ],
  pantry: [
    'rice', 'pasta', 'noodle', 'spaghetti', 'macaroni', 'flour', 'sugar', 'salt',
    'black pepper', 'oil', 'olive oil', 'vinegar', 'sauce', 'ketchup', 'mustard',
    'mayonnaise', 'mayo', 'soy sauce', 'canned', 'tin', 'bean', 'lentil', 'chickpea',
    'cereal', 'oat', 'oatmeal', 'spice', 'honey', 'jam', 'jelly', 'peanut butter',
    'nutella', 'stock', 'broth', 'cracker', 'chip', 'snack', 'nut', 'almond', 'cashew',
    'peanut', 'walnut', 'raisin', 'quinoa', 'couscous', 'coffee', 'tea', 'chocolate',
    'biscuit', 'cookie', 'syrup', 'granola', 'tahini', 'hummus', 'olive', 'pickle',
    'baking powder', 'baking soda', 'vanilla', 'yeast', 'tomato paste', 'masala',
    'cumin', 'turmeric', 'paprika', 'cinnamon', 'instant noodle', 'ramen',
  ],
  meat: [
    'chicken', 'beef', 'pork', 'bacon', 'sausage', 'ham', 'turkey', 'fish', 'salmon',
    'tuna', 'shrimp', 'lamb', 'mince', 'steak', 'meatball', 'hot dog', 'salami',
    'pepperoni', 'anchovy', 'cod', 'tilapia', 'seafood', 'deli',
  ],
  frozen: ['frozen', 'ice cream', 'popsicle', 'frozen pizza', 'frozen pea', 'frozen berry'],
  drinks: [
    'juice', 'soda', 'cola', 'sparkling water', 'mineral water', 'water', 'beer', 'wine',
    'kombucha', 'lemonade', 'iced tea', 'energy drink', 'drink', 'beverage',
  ],
  household: [
    'soap', 'detergent', 'dish soap', 'paper towel', 'toilet paper', 'foil',
    'plastic wrap', 'cleaner', 'sponge', 'trash bag', 'shampoo', 'toothpaste', 'tissue',
    'napkin', 'battery', 'laundry', 'bleach',
  ],
};

const KEYWORD_INDEX = Object.entries(SECTION_RULES)
  .flatMap(([section, words]) =>
    words.map((word) => ({ section, keyword: ' ' + normalizeKey(word) + ' ' })),
  )
  .sort((a, b) => b.keyword.length - a.keyword.length);

const MODEL_SECTION_ALIASES = {
  produce: 'produce',
  fruit: 'produce',
  vegetable: 'produce',
  veggies: 'produce',
  dairy: 'dairy',
  eggs: 'dairy',
  cheese: 'dairy',
  bakery: 'bakery',
  bread: 'bakery',
  pantry: 'pantry',
  dry: 'pantry',
  'dry goods': 'pantry',
  grains: 'pantry',
  canned: 'pantry',
  meat: 'meat',
  fish: 'meat',
  seafood: 'meat',
  protein: 'meat',
  frozen: 'frozen',
  freezer: 'frozen',
  drinks: 'drinks',
  beverages: 'drinks',
  beverage: 'drinks',
  household: 'household',
  cleaning: 'household',
  other: 'other',
};

export function normalizeSection(value) {
  const key = normalizeKey(value);
  return MODEL_SECTION_ALIASES[key] || null;
}

/**
 * Put an item in a store section. Our own keyword table wins because it is
 * deterministic; the model's suggestion is only a fallback.
 */
export function classifySection(name, modelSection) {
  const padded = ' ' + canonicalKey(name) + ' ';
  if (padded.trim()) {
    for (const { keyword, section } of KEYWORD_INDEX) {
      if (padded.includes(keyword)) return section;
    }
  }
  return normalizeSection(modelSection) || 'other';
}

function tokens(key) {
  return key ? key.split(' ').filter(Boolean) : [];
}

// If the longer name adds one of these words, it is a different product:
// "oat milk" is not milk, "tomato sauce" is not tomatoes.
const DISTINCT_TOKENS = new Set([
  'oat', 'almond', 'soy', 'coconut', 'cashew', 'chocolate', 'spring', 'powder',
  'sauce', 'paste', 'juice', 'chip', 'ice', 'pickle', 'vinegar', 'butter', 'green',
]);

/**
 * Does a seen item count as one of the user's staples?
 * Exact key, or one name fully contains the other as whole words.
 */
export function matchesStaple(stapleName, seenName) {
  const a = canonicalKey(stapleName);
  const b = canonicalKey(seenName);
  if (!a || !b) return false;
  if (a === b) return true;
  const at = tokens(a);
  const bt = tokens(b);
  const extra = at.length >= bt.length ? at.filter((w) => !bt.includes(w)) : bt.filter((w) => !at.includes(w));
  const shorter = at.length <= bt.length ? at : bt;
  const longer = at.length <= bt.length ? bt : at;
  if (!shorter.every((word) => longer.includes(word))) return false;
  if (extra.some((word) => DISTINCT_TOKENS.has(word))) return false;
  return true;
}

function strength(confidence) {
  return { high: 3, medium: 2, low: 1 }[confidence] || 0;
}

/**
 * Build the grocery list.
 *
 * @param {object} input
 * @param {string[]} input.staples   user's usual staples
 * @param {Array} input.seen         validated items from the vision model
 * @param {Array} [input.manual]     items the user typed in themselves
 * @param {number} [input.maxItems]  hard cap, because a list of 200 is not lazy
 * @returns {{items: object[], alreadyHave: object[], unknownStaples: string[]}}
 */
export function diffStaples({ staples = [], seen = [], manual = [], maxItems = 60 } = {}) {
  const seenList = (Array.isArray(seen) ? seen : []).filter(
    (item) => item && typeof item.name === 'string' && item.name.trim(),
  );
  const stapleList = (Array.isArray(staples) ? staples : [])
    .map((name) => cleanText(name, 48))
    .filter(Boolean);

  const items = [];
  const usedSeen = new Set();
  const alreadyHave = [];
  const unmatchedStaples = [];

  const push = (entry) => {
    const key = canonicalKey(entry.name);
    if (!key) return;
    if (items.some((existing) => existing.key === key)) return;
    items.push({
      key,
      name: cleanText(entry.name, 48),
      section: entry.section || classifySection(entry.name),
      reason: entry.reason,
      confidence: entry.confidence || null,
      quantity: cleanText(entry.quantity || '', 60),
    });
  };

  // 1. Staples the photos did not show.
  for (const staple of stapleList) {
    const matchIndex = seenList.findIndex((item) => matchesStaple(staple, item.name));
    if (matchIndex === -1) {
      unmatchedStaples.push(staple);
      push({ name: staple, reason: 'missing' });
      continue;
    }
    usedSeen.add(matchIndex);
    const match = seenList[matchIndex];
    if (match.nearlyEmpty) {
      push({
        name: staple,
        reason: 'nearlyEmpty',
        quantity: match.quantity,
        confidence: match.confidence,
        section: classifySection(staple, match.section),
      });
    } else {
      alreadyHave.push({
        name: cleanText(match.name, 48),
        quantity: cleanText(match.quantity || '', 60),
        confidence: match.confidence || null,
      });
    }
  }

  // 2. Anything the model saw that looks nearly empty, even if it isn't a staple.
  for (let i = 0; i < seenList.length; i += 1) {
    const item = seenList[i];
    if (!item.nearlyEmpty) continue;
    push({
      name: item.name,
      reason: 'nearlyEmpty',
      quantity: item.quantity,
      confidence: item.confidence,
      section: classifySection(item.name, item.section),
    });
  }

  // 3. Things the user typed in by hand.
  for (const entry of Array.isArray(manual) ? manual : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name || !cleanText(name, 48)) continue;
    push({
      name,
      reason: 'manual',
      section: classifySection(name, typeof entry === 'object' ? entry.section : null),
    });
  }

  return {
    items: items.slice(0, Math.max(0, maxItems)),
    alreadyHave,
    unknownStaples: unmatchedStaples,
  };
}

/** Group a flat list into section buckets in store-walk order. */
export function groupBySection(items) {
  const groups = SECTION_ORDER.map((section) => ({ section, label: SECTION_LABELS[section], items: [] }));
  const bySection = new Map(groups.map((group) => [group.section, group]));
  for (const item of Array.isArray(items) ? items : []) {
    const section = bySection.has(item.section) ? item.section : 'other';
    bySection.get(section).items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

/** Plain-text version for the copy button and the .txt download. */
export function listToText(items, { date = new Date(), checked = new Set(), title = 'Fridge to List' } = {}) {
  const groups = groupBySection(items);
  const lines = [`${title} — ${date.toDateString()}`, ''];
  for (const group of groups) {
    lines.push(group.label.toUpperCase());
    for (const item of group.items) {
      const done = checked.has(item.key) ? ' (got it)' : '';
      const note = item.quantity ? ` — ${item.quantity}` : '';
      lines.push(`- ${titleCase(item.name)}${note}${done}`);
    }
    lines.push('');
  }
  if (!groups.length) lines.push('(nothing on the list yet)', '');
  lines.push('Made locally with Fridge to List + Gemma 3 via Ollama.');
  return lines.join('\n');
}
