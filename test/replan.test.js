const test = require('node:test');
const assert = require('node:assert');
const { bestCompletion, changeCandidates, walkTo } = require('../lib/replan');

const T = 1_800_000_000_000;
const min = (m) => T + m * 60_000;

// 69 Ann St, and a 444-like ride from stop 9 into the city
const WORK = { lat: -27.4692, lon: 153.0226 };
const board = { stopId: 's9', name: 'Coronation Dr, stop 9', seq: 5, lat: -27.4768, lon: 153.0005, etaMs: min(0) };
const roma = { stopId: 'roma', name: 'Roma Street busway', seq: 8, lat: -27.4655, lon: 153.0185, etaMs: min(10), hub: true };
const kgs = { stopId: 'kgs', name: 'King George Square', seq: 9, lat: -27.4686, lon: 153.0237, etaMs: min(14), hub: true };
const far = { stopId: 'far', name: 'Fortitude Valley', seq: 12, lat: -27.4575, lon: 153.0345, etaMs: min(22) };

test('getting off near the destination and walking needs no planner', async () => {
    let asked = 0;
    const { best } = await bestCompletion({ ahead: [roma, kgs, far], board, dest: WORK, planFrom: () => { asked++; return null; } });
    assert.equal(best.kind, 'walk');
    assert.equal(best.alight.stopId, 'kgs');
    assert.ok(asked <= 2, 'only a couple of changes are tried when a walk works');
});

test("a change is the planner's own answer, and wins when it's sooner", async () => {
    // From Roma St the planner finds a bus to stop 12, right by work, arriving at min 13
    const planFrom = (s) => s.stopId === 'roma'
        ? { endTime: min(13), walkDistance: 120, transfers: 0, legs: [{ mode: 'WALK' }, { mode: 'BUS' }, { mode: 'WALK' }] }
        : null;
    const { best } = await bestCompletion({ ahead: [roma, kgs, far], board, dest: WORK, planFrom });
    assert.equal(best.kind, 'change');
    assert.equal(best.alight.stopId, 'roma');
    assert.equal(best.transfers, 1);
    assert.equal(best.arriveMs, min(13));
});

test('arrivals within a minute go to fewer changes', async () => {
    const kgsWalk = walkTo(kgs, WORK).s * 1000;
    // The change arrives just 30 s sooner than getting off at King George Square and walking
    const planFrom = (s) => s.stopId === 'roma' ? { endTime: min(14) + kgsWalk - 30_000, walkDistance: 80, legs: [{ mode: 'BUS' }] } : null;
    const { best } = await bestCompletion({ ahead: [roma, kgs], board, dest: WORK, planFrom });
    assert.equal(best.kind, 'walk');
});

test('least walking when that is the preference', async () => {
    const planFrom = (s) => s.stopId === 'roma' ? { endTime: min(25), walkDistance: 40, legs: [{ mode: 'BUS' }] } : null;
    const { best } = await bestCompletion({ ahead: [roma, kgs], board, dest: WORK, planFrom, prefer: 'walking' });
    assert.equal(best.alight.stopId, 'roma');
});

test('nowhere near the destination: the planner is asked from the hubs ahead', async () => {
    const DEST = { lat: -27.60, lon: 153.03 };   // far south: no stop on this ride is walkable
    const askedAt = [];
    const planFrom = (s, atMs) => { askedAt.push([s.stopId, atMs]); return { endTime: min(60), walkDistance: 300, legs: [{ mode: 'BUS' }] }; };
    const { best } = await bestCompletion({ ahead: [roma, kgs, far], board, dest: DEST, planFrom });
    assert.equal(best.kind, 'change');
    assert.ok(askedAt.length >= 1 && askedAt.length <= 3);
    // Asked for a minute after the bus gets there: time to get off and find the next stop
    const [id, at] = askedAt.find(([sid]) => sid === best.alight.stopId);
    assert.equal(at, (id === 'roma' ? roma : kgs).etaMs + 60_000);
});

test('a planner failure just leaves the walk', async () => {
    const { best } = await bestCompletion({ ahead: [kgs], board, dest: WORK, planFrom: () => { throw new Error('OTP down'); } });
    assert.equal(best.kind, 'walk');
});

test('change candidates are hubs closer to the destination, nearest first', () => {
    const c = changeCandidates([roma, kgs, far], board, WORK, 3);
    assert.deepEqual(c.map(s => s.stopId), ['kgs', 'roma']);
    // No hubs at all: the stop nearest the destination
    assert.deepEqual(changeCandidates([{ ...far, hub: false }], board, WORK, 3).map(s => s.stopId), ['far']);
});

test('a shape is cut to the ride and encoded', () => {
    const { cutShape, encodePolyline } = require('../lib/replan');
    const shape = Array.from({ length: 10 }, (_, i) => [-27.47, 153.0 + i * 0.001]);
    const cut = cutShape(shape, { lat: -27.47, lon: 153.002 }, { lat: -27.47, lon: 153.006 });
    assert.equal(cut.length, 5);
    assert.equal(encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

test('the real walk replaces the estimate for the best stops', async () => {
    // King George Square looks 2 min away in a straight line, but the real walk is 6 min
    const walkFrom = (s) => s.stopId === 'kgs' ? { s: 360, m: 420, geometry: 'abc', steps: [] } : null;
    const { best, options } = await bestCompletion({ ahead: [roma, kgs], board, dest: WORK, planFrom: () => null, walkFrom });
    const k = options.find(o => o.alight.stopId === 'kgs' && o.kind === 'walk');
    assert.equal(k.arriveMs, kgs.etaMs + 360_000);
    assert.equal(k.walk.geometry, 'abc');
    assert.ok(best);
});

const { legOnTrip } = require('../lib/replan');

test('a planned ride finds its live times on the trip, boarding before getting off', () => {
    const stops = [
        { stopId: 'a', code: '001', etaMs: min(0), live: false },
        { stopId: 'b', code: '600030', etaMs: min(8), scheduledMs: min(2), live: true },
        { stopId: 'c', code: '600119', etaMs: min(76), live: true },
        { stopId: 'd', code: '600030', etaMs: min(90), live: true }   // a loop back through the same station
    ];
    assert.deepEqual(legOnTrip(stops, '600030', '600119'), { departMs: min(8), arriveMs: min(76), scheduledDepartMs: min(2), live: true });
    assert.deepEqual(legOnTrip(stops, 'a', 'b'), { departMs: min(0), arriveMs: min(8), scheduledDepartMs: null, live: true });
    assert.equal(legOnTrip(stops, '600119', '001'), null, 'getting off before boarding is no ride');
    assert.equal(legOnTrip(stops, 'zzz', '600119'), null);
    assert.equal(legOnTrip(stops, null, '600119'), null);
});
