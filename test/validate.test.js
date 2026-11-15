const test = require('node:test');
const assert = require('node:assert');
const { radiusOf, planQuery, MAX_RADIUS_M } = require('../lib/validate');

const now = () => ({ date: '2026-11-15', time: '8:05am' });
const home = { fromLat: '-27.4806', fromLon: '152.9965', toLat: '-27.9597', toLon: '153.3818' };

test('a radius is capped, and nonsense falls back to the default', () => {
    assert.equal(radiusOf('500', 500), 500);
    assert.equal(radiusOf('1e9', 500), MAX_RADIUS_M);
    assert.equal(radiusOf(undefined, 1000), 1000);
    assert.equal(radiusOf('-3', 500), 500);
    assert.equal(radiusOf('abc', 500), 500);
});

test('a plan query keeps what the apps send', () => {
    const r = planQuery({ ...home, date: '2026-11-15', time: '3:41pm', arriveBy: 'true' }, now);
    assert.equal(r.ok, true);
    assert.deepEqual(r.plan, { fromLat: -27.4806, fromLon: 152.9965, toLat: -27.9597, toLon: 153.3818,
        date: '2026-11-15', time: '3:41pm', modes: 'TRANSIT,WALK', arriveBy: true });
    // The web planner's encoded "3:41 PM"
    assert.equal(planQuery({ ...home, date: '2026-11-15', time: '3:41 PM' }, now).plan.time, '3:41pm');
});

test('a missing date and time mean now in Brisbane, not the UTC day', () => {
    const r = planQuery(home, now);
    assert.equal(r.plan.date, '2026-11-15');
    assert.equal(r.plan.time, '8:05am');
});

test('nothing extra rides into the planner URL', () => {
    assert.equal(planQuery({ ...home, fromLat: '-27.48&numItineraries=500' }, now).ok, false);
    assert.equal(planQuery({ ...home, modes: 'TRANSIT,WALK&numItineraries=500' }, now).ok, false);
    assert.equal(planQuery({ ...home, date: '2026-11-15&x=1', time: '8:05am' }, now).ok, false);
    assert.equal(planQuery({ ...home, date: '2026-11-15', time: '8:05am&x=1' }, now).ok, false);
    assert.equal(planQuery({ ...home, toLat: '200' }, now).ok, false);
    assert.equal(planQuery({ fromLat: '-27.48' }, now).ok, false);
});
