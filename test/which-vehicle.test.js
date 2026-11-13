const test = require('node:test');
const assert = require('node:assert');
const { parseFixes, buildGrid, cellOf, rankVehicles, reachAheadM } = require('../lib/which-vehicle');

const NOW = 2_000_000_000;
const LAT = -27.48;
const M_LON = 1 / (111_320 * Math.cos(LAT * Math.PI / 180));   // degrees of longitude per metre here
const east = (m, lat = LAT) => [lat, 153.0 + m * M_LON];

// A straight route running east, 4 km long; the reverse route runs west on the same road
const ROUTE = Array.from({ length: 41 }, (_, i) => east(-2000 + i * 100));
const REVERSE = [...ROUTE].reverse();

// A rider on a bus heading east at 10 m/s, a fix every 5 s, now at 0 m
const riding = [0, 5, 10, 15, 20].map(s => { const [lat, lon] = east(-200 + s * 10); return { lat, lon, t: NOW - 20 + s }; });
const walking = [0, 5, 10, 15, 20].map(s => { const [lat, lon] = east(-30 + s * 1.4); return { lat, lon, t: NOW - 20 + s }; });

const vehicle = (m, ageS, extra = {}) => {
    const [latitude, longitude] = east(m);
    return { position: { latitude, longitude }, timestamp: NOW - ageS, currentStopSequence: 20, ...extra };
};
const entriesOf = (vehicles) => [...buildGrid(Object.entries(vehicles), NOW).values()].flat()
    .filter((e, i, all) => all.findIndex(x => x.tripId === e.tripId) === i);
const rank = (fixes, vehicles, opts = {}) => rankVehicles(fixes, entriesOf(vehicles), {
    shapeOf: (id) => (opts.shapes?.[id] ?? ROUTE), stopSeqOf: opts.stopSeqOf
});

test('fixes are parsed, sorted oldest first, and junk dropped', () => {
    const f = parseFixes('-27.48,153.01,200;-27.47,153.0,100;x,1,2;95,0,3');
    assert.deepStrictEqual(f.map(x => x.t), [100, 200]);
});

test('the bus you are on ranks first, even with an old position behind you', () => {
    // The 460 reported 300 m back 35 s ago (it can be 420 m on by now); the 411 is 1.2 km back
    const r = rank(riding, { t460: vehicle(-300, 35), t411: vehicle(-1200, 10) });
    assert.ok(r.moving);
    assert.strictEqual(r.candidates[0].tripId, 't460');
    assert.ok(r.candidates[0].fit >= 0.85, `fit ${r.candidates[0].fit}`);
    assert.ok(!r.candidates.some(c => c.tripId === 't411' && c.fit > 0.3));
});

test('two buses bunched together come back as a tie, not a guess', () => {
    const r = rank(riding, { t444: vehicle(-40, 20), t412: vehicle(-90, 20) });
    assert.strictEqual(r.candidates.length, 2);
    for (const c of r.candidates) assert.ok(Math.abs(c.share - 0.5) < 0.1, `share ${c.share}`);
});

test('the stop you waited at breaks a tie it can', () => {
    const r = rank(riding, { t444: vehicle(-40, 20), t412: vehicle(-90, 20) },
        { stopSeqOf: (id) => (id === 't444' ? 18 : null) });
    assert.strictEqual(r.candidates[0].tripId, 't444');
    assert.ok(r.candidates[0].calledAtStop);
});

test('walking beside the road is not riding', () => {
    const r = rank(walking, { t460: vehicle(0, 5) });
    assert.strictEqual(r.moving, false);
    assert.strictEqual(r.candidates.length, 0);
});

test('a bus going the other way does not fit', () => {
    const r = rank(riding, { back: vehicle(100, 10) }, { shapes: { back: REVERSE } });
    assert.ok(!r.candidates.length || r.candidates[0].fit < 0.2);
});

test('a stale fix is skipped', () => {
    assert.strictEqual(entriesOf({ old: vehicle(0, 400) }).length, 0);
});

test('a bus the feed says is stopped is not projected far up the road', () => {
    assert.strictEqual(reachAheadM({ currentStatus: 1, position: {} }, 90), 150);
    assert.strictEqual(reachAheadM({ currentStatus: 2, position: {} }, 90), 1080);
    // Stopped at the stop you're boarding at, fix 90 s old: still fits a rider just pulling away
    const pulling = [0, 5, 10, 15, 20].map(s => { const [lat, lon] = east(-60 + s * 5); return { lat, lon, t: NOW - 20 + s }; });
    const r = rank(pulling, { atStop: vehicle(-40, 90, { currentStatus: 1 }) });
    assert.strictEqual(r.candidates[0]?.tripId, 'atStop');
});

test('the grid finds a vehicle whose old fix is a kilometre back', () => {
    const grid = buildGrid([['far', vehicle(-1000, 60, { position: { latitude: LAT, longitude: east(-1000)[1], speed: 16.7 } })]], NOW);
    const [lat, lon] = east(0);
    assert.ok(cellOf(grid, lat, lon).some(e => e.tripId === 'far'));
});

test('the grid lookup finds what a full scan finds', () => {
    const vehicles = {};
    for (let i = 0; i < 60; i++) vehicles[`v${i}`] = vehicle(-3000 + i * 100, (i * 7) % 170);
    const grid = buildGrid(Object.entries(vehicles), NOW);
    const [lat, lon] = east(0);
    const fromCell = rankVehicles(riding, cellOf(grid, lat, lon), { shapeOf: () => ROUTE }).candidates.map(c => c.tripId);
    const all = rankVehicles(riding, entriesOf(vehicles), { shapeOf: () => ROUTE }).candidates.map(c => c.tripId);
    assert.deepStrictEqual(fromCell, all);
});
