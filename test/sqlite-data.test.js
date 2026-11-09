const test = require('node:test');
const assert = require('node:assert');
const { ilike, simplify } = require('../lib/sqlite-data');

test('ilike follows SQL ILIKE', () => {
    assert.ok(ilike('%ann st%').test('ANN STREET stop 3'));
    assert.ok(!ilike('%ann st%').test('Anne Lane'));
    assert.ok(ilike('%a_b%').test('xayb'));
    assert.ok(ilike('%10\\%%').test('10%'));
    assert.ok(!ilike('%10\\%%').test('10'));
    assert.ok(ilike('%(a.%').test('x(a.b'));
    assert.ok(!ilike('%(a.%').test('x(ab'));
});

test('simplify drops points within the tolerance and keeps the ends and corners', () => {
    const line = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1]];
    assert.deepStrictEqual(simplify(line, 0.001), [[0, 0], [1, 0], [1, 1]]);
    assert.deepStrictEqual(simplify(line, 0), line);
});

test('simplify handles a closed loop', () => {
    assert.deepStrictEqual(simplify([[0, 0], [1, 0], [1, 1], [0, 0]], 0.1), [[0, 0], [1, 0], [1, 1], [0, 0]]);
});
