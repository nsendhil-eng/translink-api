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
