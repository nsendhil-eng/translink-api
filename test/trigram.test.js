const test = require('node:test');
const assert = require('node:assert');
const { trigrams, uniqueTrigrams, wordSimilarity } = require('../lib/trigram');

const sim = (q, name) => wordSimilarity(uniqueTrigrams(q), name);

test('words are letters and digits, padded as pg_trgm pads them', () => {
    assert.deepStrictEqual(trigrams("N'x"), ['  n', ' n ', '  x', ' x ']);
});

test('word similarity matches the pg_trgm documentation', () => {
    assert.ok(Math.abs(sim('word', 'two words') - 0.8) < 1e-6);
});

test('a whole word inside a longer name scores fully; unrelated names do not', () => {
    assert.strictEqual(sim('dentist', 'Rochedale Central Dentist'), 1);
    assert.strictEqual(sim('dentist', 'Bunnings'), 0);
});
