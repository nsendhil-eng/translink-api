const test = require('node:test');
const assert = require('node:assert');
const { cleanTripUpdates } = require('../lib/otp-feed');

const NOW = 2_000_000_000;
const STOPS = [
    { stop_sequence: 1, lat: -27.55, lon: 152.85 },
    { stop_sequence: 2, lat: -27.545, lon: 152.86 },
    { stop_sequence: 25, lat: -27.486, lon: 152.992 }
];
const update = ({ relationship = 0, delay = 2000, time = NOW, seq = 1 } = {}) => ({
    tripUpdate: {
        trip: { tripId: 'T', scheduleRelationship: relationship },
        stopTimeUpdate: [{ stopSequence: seq, departure: { delay, time } }]
    }
});
const vehicle = (lat, lon, currentStopSequence = 1) =>
    ({ position: { latitude: lat, longitude: lon }, currentStopSequence, timestamp: NOW - 20 });
const clean = (e, v, stops = STOPS) => cleanTripUpdates([e], {
    stopsOfTrip: () => stops, vehicleOfTrip: () => v, nowS: NOW
});

test('a replacement trip in the timetable becomes scheduled, without touching the original', () => {
    const e = update({ relationship: 5, delay: 60 });
    const { entity, stats } = clean(e, undefined);
    assert.strictEqual(entity[0].tripUpdate.trip.scheduleRelationship, 0);
    assert.strictEqual(e.tripUpdate.trip.scheduleRelationship, 5);
    assert.strictEqual(stats.relabelled, 1);
});

test('a replacement trip not in the timetable is left alone', () => {
    const { entity, stats } = clean(update({ relationship: 5, delay: 60 }), undefined, []);
    assert.strictEqual(entity[0].tripUpdate.trip.scheduleRelationship, 5);
    assert.strictEqual(stats.relabelled, 0);
});

test('the 444 case: leaving the first stop now, with the bus 15 km away, is dropped', () => {
    const { entity, stats } = clean(update(), vehicle(-27.486, 152.992));
    assert.strictEqual(entity.length, 0);
    assert.strictEqual(stats.dropped, 1);
});

test('a bus far away with time to get there stays: starting late is real', () => {
    assert.strictEqual(clean(update({ time: NOW + 1800 }), vehicle(-27.486, 152.992)).stats.dropped, 0);
});

test('a small delay is never doubted', () => {
    assert.strictEqual(clean(update({ delay: 120 }), vehicle(-27.486, 152.992)).stats.dropped, 0);
});

test('a vehicle at its stop stays, and a stale fix proves nothing', () => {
    assert.strictEqual(clean(update(), vehicle(-27.5501, 152.8501)).stats.dropped, 0);
    const old = { ...vehicle(-27.486, 152.992), timestamp: NOW - 3600 };
    assert.strictEqual(clean(update(), old).stats.dropped, 0);
});
