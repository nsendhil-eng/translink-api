const test = require('node:test');
const assert = require('node:assert');
const { parseTrail, rideCandidates, riderAlongAt } = require('../lib/ride-match');

const NOW = 2_000_000_000;
const LAT = -27.48;
const M_LON = 1 / (111_320 * Math.cos(LAT * Math.PI / 180));
const east = (m, northM = 0) => [LAT + northM / 110_540, 153.0 + m * M_LON];

// A road running east 6 km; a second route shares it to 0 m, then turns north; one runs the other way
const ROUTE = Array.from({ length: 61 }, (_, i) => east(-3000 + i * 100));
const TURNS = [...ROUTE.slice(0, 30), ...Array.from({ length: 20 }, (_, i) => east(-100, (i + 1) * 100))];
const REVERSE = [...ROUTE].reverse();

/** A rider travelling east at `mps`, a fix every 5 s for `seconds`, now at `atM` */
const trail = (mps, seconds = 60, atM = 0) => {
    const out = [];
    for (let s = seconds; s >= 0; s -= 5) { const [lat, lon] = east(atM - mps * s); out.push({ lat, lon, t: NOW - s }); }
    return out;
};
const bus = (m, ageS, northM = 0) => { const [latitude, longitude] = east(m, northM); return { position: { latitude, longitude }, timestamp: NOW - ageS }; };
const run = (fixes, vehicles, shapes = {}, trips = null) =>
    rideCandidates(fixes, Object.entries(vehicles), { shapeOf: (id) => shapes[id] ?? ROUTE, trips: trips && new Set(trips), nowS: NOW });

test('the bus you are on, from an old report far behind you: right where you were then', () => {
    // The evening 411: you at 15 m/s; it reported 50 s ago from 750 m back, which is where you were
    const r = run(trail(15), { mine: bus(-750, 50), other411: bus(-1150, 50) });
    assert.strictEqual(r.candidates[0].tripId, 'mine');
    assert.ok(r.candidates[0].fit >= 0.95, JSON.stringify(r.candidates[0]));
    assert.ok(Math.abs(r.candidates[0].gapM) <= 10);
    const other = r.candidates.find(c => c.tripId === 'other411');
    assert.ok(!other || other.fit < 0.2, 'a bus 400 m behind you at its report time is not yours');
});

test('crawling in traffic still counts: no speed floor', () => {
    const r = run(trail(2, 90), { mine: bus(-60, 30) });
    assert.ok(r.moving);
    assert.strictEqual(r.candidates[0]?.tripId, 'mine');
});

test("a route that turns off before your trail, or runs the other way, doesn't follow you", () => {
    // You're at +600 m, past where TURNS leaves the road
    const r = run(trail(10, 60, 600), { turned: bus(0, 10, 0), back: bus(600, 5) }, { turned: TURNS, back: REVERSE });
    assert.deepStrictEqual(r.candidates.map(c => c.tripId), []);
});

test('a vehicle well off its own route is not a candidate', () => {
    const r = run(trail(10), { stray: bus(0, 10, 600) });
    assert.deepStrictEqual(r.candidates, []);
});

test('standing still: no candidates', () => {
    const r = run(trail(0), { mine: bus(0, 10) });
    assert.strictEqual(r.moving, false);
    assert.deepStrictEqual(r.candidates, []);
});

test('later calls score only the named trips, even ones that no longer fit', () => {
    const r = run(trail(10), { a: bus(-100, 10), b: bus(-900, 10), c: bus(0, 10) }, {}, ['a', 'b']);
    assert.deepStrictEqual(r.candidates.map(c => c.tripId).sort(), ['a', 'b']);
    assert.ok(r.candidates.find(c => c.tripId === 'b').fit < 0.1);
});

test('where you were along the route at a time: between fixes, or carried at your pace', () => {
    const pts = [{ t: 100, along: 0 }, { t: 110, along: 100 }, { t: 120, along: 200 }];
    assert.strictEqual(riderAlongAt(pts, 105), 50);
    assert.strictEqual(riderAlongAt(pts, 90), -100);
    assert.strictEqual(riderAlongAt(pts, 130), 300);
});

test('a trail is parsed oldest first, junk dropped, kept to the last four minutes', () => {
    const f = parseTrail('-27.48,153.01,1000;-27.47,153.0,700;x,1,2;-27.46,153.0,990');
    assert.deepStrictEqual(f.map(x => x.t), [990, 1000]);
});

test('vague readings from inside a train still follow its line, with slack to match', () => {
    // GPS in a carriage: every reading 120 m off to the north, each saying it is good to 150 m
    const fixes = trail(15).map(f => ({ ...f, lat: f.lat + 120 / 110_540, acc: 150 }));
    const r = run(fixes, { train: bus(-300, 20) });
    assert.strictEqual(r.candidates[0]?.tripId, 'train');
    // The same readings claiming 10 m accuracy don't follow a line 120 m away
    const strict = run(fixes.map(f => ({ ...f, acc: 10 })), { train: bus(-300, 20) });
    assert.deepStrictEqual(strict.candidates, []);
});

test('a trail can carry each reading\'s accuracy', () => {
    const f = parseTrail('-27.48,153.01,1000,150;-27.47,153.0,990');
    assert.deepStrictEqual(f.map(x => x.acc), [null, 150]);
});
