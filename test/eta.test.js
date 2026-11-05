const test = require('node:test');
const assert = require('node:assert/strict');
const { bestItinerary, etaSummary, etaCacheKey } = require('../lib/eta');

const NOW = Date.parse('2026-11-05T10:00:00Z');
const min = (m) => NOW + m * 60000;
const walk = (from, to) => ({ mode: 'WALK', startTime: min(from), endTime: min(to), duration: (to - from) * 60 });
const bus = (route, from, to, stop) => ({
    mode: 'BUS', routeShortName: route, headsign: 'City', routeColor: 'E86AA8', routeTextColor: '000000',
    startTime: min(from), endTime: min(to), duration: (to - from) * 60, from: { name: stop }, realTime: true
});
const itin = (legs, transfers = 0) => ({
    startTime: legs[0].startTime, endTime: legs.at(-1).endTime,
    duration: (legs.at(-1).endTime - legs[0].startTime) / 1000, transfers, legs
});

test('the plan arriving first wins, walking included', () => {
    const slow = itin([walk(0, 2), bus('412', 2, 40, 'Wesley Hospital, stop 9')]);
    const fast = itin([walk(3, 8), bus('444', 8, 30, 'Coronation Dr, stop 10'), walk(30, 34)]);
    assert.equal(bestItinerary([slow, fast]), fast);
});

test('a long walk-only plan never wins; a short one can', () => {
    const longWalk = itin([walk(0, 40)]);
    const transit = itin([walk(0, 5), bus('412', 9, 45, 'Stop')]);
    assert.equal(bestItinerary([longWalk, transit]), transit);
    const shortWalk = itin([walk(0, 12)]);
    assert.equal(bestItinerary([shortWalk, transit]), shortWalk);
    assert.equal(bestItinerary([]), null);
});

test('the chip summary: total, leave-in, first route and walking', () => {
    const s = etaSummary(itin([walk(3, 8), bus('444', 8, 30, 'Coronation Dr, stop 10'), walk(30, 34)]), NOW);
    assert.equal(s.minutes, 34);
    assert.equal(s.leaveInMinutes, 3);
    assert.equal(s.walkMinutes, 9);
    assert.equal(s.walkOnly, false);
    assert.deepEqual([s.firstLeg.route, s.firstLeg.stopName, s.firstLeg.realTime], ['444', 'Coronation Dr, stop 10', true]);
    assert.equal(etaSummary(itin([walk(0, 12)]), NOW).firstLeg, null);
});

test('nearby origins share a cache entry within the same minute', () => {
    const a = etaCacheKey(-27.48020, 152.99600, -27.3855, 153.0311, NOW);
    // ~30 m away, inside the same ~150 m cell (grid cells have edges, so pick a point well inside)
    assert.equal(etaCacheKey(-27.48040, 152.99610, -27.3855, 153.0311, NOW + 20000), a);
    assert.notEqual(etaCacheKey(-27.48020, 152.99600, -27.3855, 153.0311, NOW + 61000), a);
    assert.notEqual(etaCacheKey(-27.49000, 152.99600, -27.3855, 153.0311, NOW), a);
});
