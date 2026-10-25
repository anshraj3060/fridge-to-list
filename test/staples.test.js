import test from 'node:test';
import assert from 'node:assert/strict';

import { REASON_LABELS, cleanText, normalizeKey } from '../public/lib/normalize.js';
import {
  DEFAULT_STAPLES,
  canonicalKey,
  classifySection,
  diffStaples,
  groupBySection,
  listToText,
  matchesStaple,
  normalizeSection,
} from '../public/lib/staples.js';

test('normalizeKey folds case, punctuation and plurals', () => {
  assert.equal(normalizeKey('  Greek   Yogurt! '), 'greek yogurt');
  assert.equal(normalizeKey('Tomatoes'), 'tomato');
  assert.equal(normalizeKey('berries'), 'berry');
  assert.equal(normalizeKey('Eggs & milk'), 'egg and milk');
  assert.equal(normalizeKey('---'), '');
});

test('cleanText trims bullets, quotes and length', () => {
  assert.equal(cleanText('- "milk",'), 'milk');
  assert.equal(cleanText('  lots   of   spaces  '), 'lots of spaces');
  assert.equal(cleanText('x'.repeat(80), 10).length, 10);
  assert.equal(cleanText(null), '');
});

test('canonicalKey folds common synonyms', () => {
  assert.equal(canonicalKey('yoghurt'), canonicalKey('yogurt'));
  assert.equal(canonicalKey('capsicum'), canonicalKey('bell pepper'));
  assert.equal(canonicalKey('Eggs'), canonicalKey('egg'));
  assert.equal(canonicalKey('scallions'), canonicalKey('green onion'));
});

test('matchesStaple is careful about different products', () => {
  assert.equal(matchesStaple('milk', 'milk'), true);
  assert.equal(matchesStaple('milk', 'whole milk'), true);
  assert.equal(matchesStaple('onions', 'red onion'), true);
  assert.equal(matchesStaple('milk', 'oat milk'), false);
  assert.equal(matchesStaple('tomatoes', 'tomato sauce'), false);
  assert.equal(matchesStaple('onions', 'spring onions'), false);
  assert.equal(matchesStaple('bread', 'breadcrumbs'), false);
  assert.equal(matchesStaple('', 'milk'), false);
});

test('classifySection uses our own keyword table', () => {
  assert.equal(classifySection('milk'), 'dairy');
  assert.equal(classifySection('Cheddar cheese'), 'dairy');
  assert.equal(classifySection('bananas'), 'produce');
  assert.equal(classifySection('sourdough bread'), 'bakery');
  assert.equal(classifySection('basmati rice'), 'pantry');
  assert.equal(classifySection('chicken breast'), 'meat');
  assert.equal(classifySection('dish soap'), 'household');
  assert.equal(classifySection('mystery item'), 'other');
  // The model's suggestion is only a fallback.
  assert.equal(classifySection('mystery item', 'frozen'), 'frozen');
  assert.equal(classifySection('milk', 'produce'), 'dairy');
  assert.equal(normalizeSection('beverages'), 'drinks');
  assert.equal(normalizeSection('nonsense'), null);
});

test('diffStaples marks unseen staples as missing', () => {
  const { items, alreadyHave } = diffStaples({
    staples: ['milk', 'eggs', 'bread'],
    seen: [{ name: 'milk', quantity: 'half a carton', confidence: 'high', nearlyEmpty: false }],
  });
  assert.deepEqual(items.map((item) => item.name), ['eggs', 'bread']);
  assert.ok(items.every((item) => item.reason === 'missing'));
  assert.deepEqual(alreadyHave.map((entry) => entry.name), ['milk']);
});

test('diffStaples puts nearly-empty staples on the list', () => {
  const { items } = diffStaples({
    staples: ['milk', 'eggs'],
    seen: [
      { name: 'milk', quantity: 'a splash left', confidence: 'high', nearlyEmpty: true },
      { name: 'eggs', quantity: '10 left', confidence: 'high', nearlyEmpty: false },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'milk');
  assert.equal(items[0].reason, 'nearlyEmpty');
  assert.equal(items[0].quantity, 'a splash left');
  assert.equal(items[0].section, 'dairy');
});

test('diffStaples respects synonyms when deciding what is already there', () => {
  const { items } = diffStaples({
    staples: ['eggs', 'yogurt'],
    seen: [
      { name: 'egg', nearlyEmpty: false },
      { name: 'greek yoghurt', nearlyEmpty: false },
    ],
  });
  assert.deepEqual(items, []);
});

test('diffStaples adds non-staple items that look nearly empty', () => {
  const { items, alreadyHave } = diffStaples({
    staples: ['milk'],
    seen: [
      { name: 'milk', nearlyEmpty: false },
      { name: 'ketchup', nearlyEmpty: true, quantity: 'just the dregs', confidence: 'medium' },
      { name: 'apples', nearlyEmpty: false },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'ketchup');
  assert.equal(items[0].reason, 'nearlyEmpty');
  assert.equal(items[0].section, 'pantry');
  assert.equal(alreadyHave.length, 1);
});

test('diffStaples merges manual items without duplicates', () => {
  const { items } = diffStaples({
    staples: ['bread'],
    seen: [],
    manual: ['Coffee', { name: 'coffee ' }, '  oat milk  '],
  });
  assert.deepEqual(items.map((item) => item.name), ['bread', 'Coffee', 'oat milk']);
  assert.equal(items[1].reason, 'manual');
  assert.equal(items[0].reason, 'missing');
});

test('diffStaples caps the list and ignores junk', () => {
  const manual = Array.from({ length: 80 }, (_, i) => `thing ${i}`);
  const { items } = diffStaples({ staples: [], seen: [{ name: null }, {}], manual, maxItems: 25 });
  assert.equal(items.length, 25);
});

test('diffStaples treats a missing staple list honestly', () => {
  const { items, alreadyHave } = diffStaples({
    staples: [],
    seen: [{ name: 'milk', nearlyEmpty: false }],
  });
  assert.deepEqual(items, []);
  assert.deepEqual(alreadyHave, []);
});

test('groupBySection follows store-walk order and drops empty buckets', () => {
  const groups = groupBySection([
    { name: 'rice', section: 'pantry' },
    { name: 'milk', section: 'dairy' },
    { name: 'banana', section: 'produce' },
    { name: 'mystery', section: 'unknown-section' },
  ]);
  assert.deepEqual(groups.map((group) => group.section), ['produce', 'dairy', 'pantry', 'other']);
  assert.equal(groups[0].items[0].name, 'banana');
});

test('listToText groups, notes quantities and marks checked items', () => {
  const text = listToText(
    [
      { key: 'milk', name: 'milk', section: 'dairy', reason: 'nearlyEmpty', quantity: 'a splash' },
      { key: 'bread', name: 'bread', section: 'bakery', reason: 'missing', quantity: '' },
    ],
    { date: new Date('2026-10-22T10:00:00Z'), checked: new Set(['bread']) },
  );
  assert.match(text, /^Fridge to List/);
  assert.match(text, /DAIRY & EGGS/);
  assert.match(text, /- Milk — a splash/);
  assert.match(text, /- Bread \(got it\)/);
  assert.ok(text.indexOf('DAIRY & EGGS') < text.indexOf('BAKERY'));
  assert.match(text, /Made locally with Fridge to List/);
});

test('default staples are sensible and unique', () => {
  assert.ok(DEFAULT_STAPLES.length >= 5);
  const keys = DEFAULT_STAPLES.map(canonicalKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('milk'));
  assert.ok(keys.includes('egg'));
});

test('reason labels exist for every reason the diff emits', () => {
  for (const reason of ['missing', 'nearlyEmpty', 'manual']) {
    assert.equal(typeof REASON_LABELS[reason], 'string');
  }
});
