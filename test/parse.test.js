import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ParseError,
  decodePhoto,
  extractJson,
  parseModelResponse,
  validateAnalyzeRequest,
} from '../lib/parse.js';

const validBase64 = Buffer.from('a'.repeat(200)).toString('base64');

test('extractJson reads plain JSON', () => {
  assert.deepEqual(extractJson('{"items":[]}'), { items: [] });
});

test('extractJson unwraps markdown fences', () => {
  const raw = 'Here you go:\n```json\n{"items":[{"name":"milk"}]}\n```\nEnjoy!';
  assert.deepEqual(extractJson(raw), { items: [{ name: 'milk' }] });
});

test('extractJson copes with smart quotes and trailing commas', () => {
  const raw = '{"items":[{"name":"milk",},],}';
  assert.deepEqual(extractJson(raw), { items: [{ name: 'milk' }] });
});

test('extractJson ignores braces inside strings', () => {
  const raw = 'note { "items": [ { "name": "salsa {mild}" } ] } tail';
  assert.deepEqual(extractJson(raw), { items: [{ name: 'salsa {mild}' }] });
});

test('extractJson returns undefined for prose', () => {
  assert.equal(extractJson('I cannot see a fridge in these photos.'), undefined);
});

test('parseModelResponse normalizes items and confidence', () => {
  const result = parseModelResponse(
    JSON.stringify({
      items: [
        { name: '  Milk  ', quantity: 'half a carton', confidence: 'HIGH' },
        { name: 'eggs', confidence: 'medium', nearlyEmpty: 'yes' },
        { name: 'mystery jar' },
      ],
      unclear: ['blurry green bottle'],
    }),
  );
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].name, 'Milk');
  assert.equal(result.items[0].confidence, 'high');
  assert.equal(result.items[1].nearlyEmpty, true);
  assert.equal(result.items[2].confidence, 'low');
  assert.equal(result.items[2].quantity, '');
  assert.deepEqual(result.unclear, ['blurry green bottle']);
});

test('parseModelResponse de-duplicates and keeps the stronger signal', () => {
  const result = parseModelResponse({
    items: [
      { name: 'Eggs', confidence: 'low', nearlyEmpty: false },
      { name: 'eggs ', confidence: 'high', quantity: '6 left', nearlyEmpty: true },
      { name: 'EGG', confidence: 'medium' },
    ],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].confidence, 'high');
  assert.equal(result.items[0].nearlyEmpty, true);
  assert.equal(result.items[0].quantity, '6 left');
  assert.equal(result.stats.dropped, 0);
});

test('parseModelResponse trims names and drops empty entries', () => {
  const result = parseModelResponse({
    items: ['- bananas ', '', '   ', null, { name: '' }, { quantity: 'no name' }, 42],
  });
  assert.deepEqual(result.items.map((item) => item.name), ['bananas', '42']);
  assert.equal(result.stats.dropped, 5);
});

test('parseModelResponse caps the item list', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: `item ${i}` }));
  const result = parseModelResponse({ items }, { limits: { ...{ items: 40, unclear: 8, nameLength: 48, quantityLength: 60, noteLength: 120 }, items: 40 } });
  assert.equal(result.items.length, 40);
  assert.equal(result.stats.received, 60);
  assert.equal(result.stats.truncated, true);
});

test('parseModelResponse caps and de-dupes unclear notes', () => {
  const unclear = ['a jar', 'A jar', ...Array.from({ length: 20 }, (_, i) => `thing ${i}`)];
  const result = parseModelResponse({ items: [], unclear });
  assert.equal(result.unclear.length, 8);
  assert.equal(result.unclear[0], 'a jar');
});

test('parseModelResponse accepts a bare array and simple strings', () => {
  const result = parseModelResponse('[{"name":"bread"}, "jam"]');
  assert.deepEqual(result.items.map((item) => item.name), ['bread', 'jam']);
});

test('parseModelResponse maps odd nearly-empty wording', () => {
  const result = parseModelResponse({
    items: [
      { name: 'rice', status: 'running low' },
      { name: 'pasta', status: 'full' },
      { name: 'flour', nearly_empty: 1 },
    ],
  });
  assert.equal(result.items[0].nearlyEmpty, true);
  assert.equal(result.items[1].nearlyEmpty, false);
  assert.equal(result.items[2].nearlyEmpty, true);
});

test('parseModelResponse rejects prose', () => {
  assert.throws(() => parseModelResponse('Sorry, I cannot help with that.'), ParseError);
});

test('parseModelResponse rejects JSON without an items list', () => {
  assert.throws(() => parseModelResponse('{"message":"hello"}'), (error) => {
    assert.ok(error instanceof ParseError);
    assert.match(error.message, /no "items" list/i);
    return true;
  });
});

test('decodePhoto accepts data URLs and bare base64', () => {
  const fromDataUrl = decodePhoto(`data:image/png;base64,${validBase64}`);
  assert.equal(fromDataUrl.mime, 'image/png');
  assert.equal(fromDataUrl.base64, validBase64);
  const bare = decodePhoto(validBase64);
  assert.equal(bare.mime, 'image/jpeg');
  assert.equal(decodePhoto('not base64!!'), null);
  assert.equal(decodePhoto(''), null);
});

test('validateAnalyzeRequest accepts good input and applies the default model', () => {
  const { images, model } = validateAnalyzeRequest(
    { images: [`data:image/jpeg;base64,${validBase64}`] },
    { defaultModel: 'gemma3:4b' },
  );
  assert.equal(images.length, 1);
  assert.equal(model, 'gemma3:4b');
});

test('validateAnalyzeRequest rejects too many photos and bad payloads', () => {
  const five = Array.from({ length: 5 }, () => `data:image/jpeg;base64,${validBase64}`);
  assert.throws(() => validateAnalyzeRequest({ images: five }), /Four is the most/);
  assert.throws(() => validateAnalyzeRequest({}), /at least one photo/i);
  assert.throws(() => validateAnalyzeRequest({ images: [] }), /at least one photo/i);
  assert.throws(
    () => validateAnalyzeRequest({ images: [`data:image/gif;base64,${validBase64}`] }),
    /not supported/i,
  );
  assert.throws(
    () => validateAnalyzeRequest({ images: [`data:image/jpeg;base64,${validBase64}`], model: 'bad model name!' }),
    /model name/i,
  );
});
