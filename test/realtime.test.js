const test = require('node:test');
const assert = require('node:assert/strict');
const rt = require('../lib/realtime');
const rec = require('./fixtures/recorded-2026-11-01.json');

const NOW = rec.recordedAt;   // Unix seconds the fixture was recorded at
const at = (iso) => new Date(iso);

// --- Service day and timetable times ------------------------------------------

test('service day is the Brisbane date, not the UTC one', () => {
    // 01:30 Monday in Brisbane is still Sunday in UTC
    const d = rt.serviceDay(at('2026-11-01T15:30:00Z'));
    assert.equal(d.dateString, '20261102');
    assert.equal(d.dayOfWeek, 'monday');
    assert.deepEqual([d.year, d.month, d.day], [2026, 10, 2]);
});

test('GTFS times past 24:00 roll into the next morning', () => {
    const day = rt.serviceDay(at('2026-11-01T02:00:00Z'));          // Sunday 1 Nov, Brisbane
    assert.equal(rt.scheduledUtc(day, '08:15:00').toISOString(), '2026-10-31T22:15:00.000Z');
    assert.equal(rt.scheduledUtc(day, '25:15:30').toISOString(), '2026-11-01T15:15:30.000Z');
    assert.equal(rt.formatBrisbane(rt.scheduledUtc(day, '25:15:30')), '01:15');
});

test('after midnight, yesterday’s late trips are still due', () => {
    // 12:30 am Monday 2 Nov in Brisbane
    const days = rt.activeServiceDays(at('2026-11-01T14:30:00Z'));
    assert.deepEqual(days.map(d => [d.dateString, d.dayOfWeek, d.fromTime]), [
        ['20261101', 'sunday', '22:30:00'],      // Sunday's 24:35 bus is 5 min away
        ['20261102', 'monday', '00:00:00']
    ]);
    assert.equal(rt.scheduledUtc(days[0], '24:35:00').toISOString(), '2026-11-01T14:35:00.000Z');
});

test('by mid-morning only today’s timetable is read, from two hours back', () => {
    const days = rt.activeServiceDays(at('2026-11-02T00:15:00Z'));   // 10:15 am Monday
    assert.deepEqual(days.map(d => [d.dateString, d.fromTime]), [['20261102', '08:15:00']]);
    assert.equal(rt.gtfsTime(91800), '25:30:00');
});

test('toNum reads protobuf Longs, numbers and junk', () => {
    assert.equal(rt.toNum({ toNumber: () => 1793524055 }), 1793524055);
    assert.equal(rt.toNum(42), 42);
    assert.equal(rt.toNum(null), null);
    assert.equal(rt.toNum('abc'), null);
});

// --- Live time at a stop --------------------------------------------------------

const sched = at('2026-11-01T09:00:00Z');
const T = sched.getTime() / 1000;

test('a stop’s own predicted time wins', () => {
    const stus = [{ stopSequence: 5, departure: { time: T + 120, delay: 120 } }];
    const live = rt.liveStopTime(stus, 5, sched);
    assert.equal(live.estimatedUtc.getTime(), (T + 120) * 1000);
    assert.equal(live.isRealtime, true);
    assert.equal(live.delaySeconds, 120);
});

test('a delay with no time still moves the estimate', () => {
    const live = rt.liveStopTime([{ stopSequence: 5, departure: { delay: 90 } }], 5, sched);
    assert.equal(live.delaySeconds, 90);
    assert.equal(live.estimatedUtc.getTime(), sched.getTime() + 90_000);
});

test('an earlier stop’s delay carries forward to stops with no update', () => {
    const stus = [
        { stopSequence: 2, departure: { time: T - 600, delay: 30 } },
        { stopSequence: 4, arrival: { delay: 200 } }
    ];
    const live = rt.liveStopTime(stus, 7, sched);
    assert.equal(live.delaySeconds, 200, 'uses the latest earlier stop, not the first');
});

test('no usable update means the timetable', () => {
    const live = rt.liveStopTime([{ stopSequence: 9, departure: { delay: 60 } }], 5, sched);
    assert.deepEqual(live, { estimatedUtc: sched, isRealtime: false, delaySeconds: null });
    assert.equal(rt.liveStopTime(undefined, 5, sched).isRealtime, false);
});

test('recorded: a trip’s last stop only has an arrival time, and that is used', () => {
    // 411 to UQ: Translink predicted the terminus 237 s early, arrival only
    const stus = rec.terminusTrip.stopTimeUpdate;
    const last = stus[stus.length - 1];
    assert.equal(last.departure, undefined);
    const scheduled = new Date((last.arrival.time - last.arrival.delay) * 1000);
    const live = rt.liveStopTime(stus, last.stopSequence, scheduled);
    assert.equal(live.isRealtime, true);
    assert.equal(live.delaySeconds, -237);
});

// --- Passed, cancelled, skipped -------------------------------------------------

test('recorded: updates that start after a stop mean the trip has been and gone there', () => {
    const { stopTimeUpdate: stus } = rec.underwayTrip;
    const first = stus[0].stopSequence;
    assert.equal(rt.passedPerFeed(stus, first - 1, null, NOW), true);
    assert.equal(rt.passedPerFeed(stus, first, null, NOW), false);
    assert.equal(rt.passedPerFeed(stus, first + 3, null, NOW), false);
});

test('a fresh vehicle beyond the stop has passed it, even if predictions say otherwise', () => {
    const stus = [{ stopSequence: 4, departure: { time: NOW + 60 } }];
    const vehicle = { currentStopSequence: 5, timestamp: NOW - 20 };
    assert.equal(rt.passedPerFeed(stus, 4, vehicle, NOW), true);
});

test('a stale vehicle can’t say the trip has passed', () => {
    const vehicle = { currentStopSequence: 9, timestamp: NOW - rt.VEHICLE_STALE_S - 1 };
    assert.equal(rt.vehiclePassedStop(vehicle, 4, NOW), false);
    assert.equal(rt.passedPerFeed([], 4, vehicle, NOW), false);
});

test('a vehicle with no timestamp counts as fresh', () => {
    assert.equal(rt.vehiclePassedStop({ currentStopSequence: 9 }, 4, NOW), true);
});

test('cancelled trips and skipped stops', () => {
    assert.equal(rt.isTripCancelled({ trip: { scheduleRelationship: rt.TRIP_CANCELED } }), true);
    assert.equal(rt.isTripCancelled({ trip: { scheduleRelationship: 0 } }), false);
    assert.equal(rt.isTripCancelled(undefined), false);
    const stus = [{ stopSequence: 3, scheduleRelationship: rt.STOP_SKIPPED }, { stopSequence: 4 }];
    assert.equal(rt.isStopSkipped(stus, 3), true);
    assert.equal(rt.isStopSkipped(stus, 4), false);
});

// --- Vehicle fixes ----------------------------------------------------------------

test('fix age and freshness', () => {
    assert.equal(rt.fixAgeSeconds(NOW - 40, NOW), 40);
    assert.equal(rt.fixAgeSeconds({ toNumber: () => NOW - 5 }, NOW), 5);
    assert.equal(rt.fixAgeSeconds(null, NOW), null);
    assert.equal(rt.fixAgeSeconds(NOW + 3, NOW), 0, 'clock skew never gives a negative age');
    assert.equal(rt.isFreshFix(NOW - rt.VEHICLE_STALE_S, NOW), true);
    assert.equal(rt.isFreshFix(NOW - rt.VEHICLE_STALE_S - 1, NOW), false);
});

const pick = (vehicles) => vehicles.reduce((cur, v) => (rt.preferVehicle(v, cur, NOW) ? v : cur), null);

test('recorded: two fresh vehicles on one trip — keep the one furthest behind', () => {
    const pair = rec.duplicateVehicles.find(p => p.every(v => rt.isFreshFix(v.timestamp, NOW)));
    assert.deepEqual(pair.map(v => v.currentStopSequence).sort((a, b) => a - b), [11, 18]);
    assert.equal(pick(pair).currentStopSequence, 11);
    assert.equal(pick([...pair].reverse()).currentStopSequence, 11, 'order in the feed doesn’t matter');
});

test('recorded: a fresh fix beats one from over an hour ago', () => {
    const pair = rec.duplicateVehicles.find(p => p.some(v => !rt.isFreshFix(v.timestamp, NOW)));
    const chosen = pick(pair);
    assert.equal(rt.isFreshFix(chosen.timestamp, NOW), true);
    assert.equal(pick([...pair].reverse()), chosen);
});

test('a departure still to come is shown at most a minute early', () => {
    const { liveStopTime } = require('../lib/realtime');
    const scheduled = new Date(Date.now() + 30 * 60_000);
    const early = liveStopTime([{ stopSequence: 14, departure: { delay: -696 } }], 14, scheduled);
    assert.strictEqual(early.delaySeconds, -60);
    assert.strictEqual(early.isRealtime, true);
    const late = liveStopTime([{ stopSequence: 14, departure: { delay: 300 } }], 14, scheduled);
    assert.strictEqual(late.delaySeconds, 300);
    // Already past: left as reported
    const past = liveStopTime([{ stopSequence: 14, departure: { delay: -600 } }], 14, new Date(Date.now() - 60_000));
    assert.strictEqual(past.delaySeconds, -600);
});

const { alignTripUpdate } = require('../lib/realtime');

// The 7:21 Springfield Central train, running express Indooroopilly to Roma Street (19 Nov 2026)
const LINE = [
    ['600290', 'Corinda'], ['600302', 'Chelmer'], ['600298', 'Indooroopilly'], ['600296', 'Taringa'], ['600292', 'Toowong'],
    ['600284', 'Auchenflower'], ['600280', 'Milton'], ['600038', 'Roma Street'], ['600024', 'Central'], ['600011', 'Fortitude Valley']
].map(([stop_id], i) => ({ stop_sequence: 8 + i, stop_id }));
const upd = (seq, stopId, delay) => ({ stopSequence: seq, stopId, departure: { delay } });

test('an express trip renumbered by the feed lines up by stop, and the stops it runs past are skipped', () => {
    // The feed: Chelmer 9, Indooroopilly 10, then Roma Street 11, Central 12, Fortitude Valley 13
    const tu = { trip: { tripId: 'x' }, stopTimeUpdate: [upd(9, '600302', 297), upd(10, '600298', 310), upd(11, '600038', 153), upd(12, '600024', 176), upd(13, '600011', 86)] };
    const a = alignTripUpdate(tu, LINE);
    const at = (seq) => a.stopTimeUpdate.find(u => u.stopSequence === seq);
    assert.strictEqual(at(10).stopId, '600298');                       // Indooroopilly stays 10
    assert.strictEqual(at(15).stopId, '600038');                       // Roma Street is the timetable's 15
    assert.strictEqual(at(17).departure.delay, 86);                    // Fortitude Valley's own time
    for (const seq of [11, 12, 13, 14]) assert.strictEqual(at(seq).scheduleRelationship, 1, `stop ${seq} skipped`);
    assert.strictEqual(at(13).stopId, '600284');                       // Auchenflower: not stopping
});

test('a trip whose numbers agree comes back untouched', () => {
    const tu = { stopTimeUpdate: [upd(10, '600298', 30), upd(13, '600284', 40)] };
    assert.strictEqual(alignTripUpdate(tu, LINE), tu);
});

test('a gap in the updates is not a skip', () => {
    // Renumbered (off by one), but the feed's own numbers jump too: stops just not updated
    const tu = { stopTimeUpdate: [upd(9, '600298', 30), upd(12, '600284', 40)] };
    const a = alignTripUpdate(tu, LINE);
    assert.deepStrictEqual(a.stopTimeUpdate.map(u => [u.stopSequence, u.scheduleRelationship ?? 0]), [[10, 0], [13, 0]]);
});

test('another platform of the same station still lines up', () => {
    const tu = { stopTimeUpdate: [upd(1, '600039', 60)] };   // Roma Street platform 10, feed numbered 1
    const a = alignTripUpdate(tu, LINE, (x, y) => x === y || (x.startsWith('60003') && y.startsWith('60003')));
    assert.strictEqual(a.stopTimeUpdate[0].stopSequence, 15);
});

const { alignVehicle } = require('../lib/realtime');

test("the vehicle on a renumbered trip gets the timetable's stop number too", () => {
    const tu = { stopTimeUpdate: [upd(9, '600302', 297), upd(10, '600298', 310), upd(11, '600038', 153), upd(12, '600024', 176)] };
    const a = alignTripUpdate(tu, LINE);
    // The train heading to Roma Street: the feed says stop 11, the timetable's Roma Street is 15
    assert.strictEqual(alignVehicle({ currentStopSequence: 11, position: {} }, a).currentStopSequence, 15);
    const v = { currentStopSequence: 11 };
    assert.strictEqual(alignVehicle(v, tu), v, 'not renumbered: as it was');
});
