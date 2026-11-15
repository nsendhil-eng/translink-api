const test = require('node:test');
const assert = require('node:assert');
const { createLimiter, tierOf, clientIp } = require('../lib/rate-limit');

const T = 1_800_000_000_000;
const tiers = { expensive: { limit: 3, paths: ['/api/plan'] }, general: { limit: 5, paths: null } };

test('the planner and address search are the expensive tier', () => {
    for (const p of ['/api/plan', '/api/stop-options', '/api/replan-from-trip', '/api/walk', '/api/eta', '/api/places']) assert.equal(tierOf(p), 'expensive');
    for (const p of ['/api/departures', '/api/plan-live', '/api/stops-near-me', '/api/health']) assert.equal(tierOf(p), 'general');
});

test('a caller over the limit waits for the next minute', () => {
    const l = createLimiter({ tiers: { ...tiers, expensive: { limit: 3, paths: ['/api/plan'] } } });
    for (let i = 0; i < 3; i++) assert.equal(l.check('1.2.3.4', '/api/plan', T + i).ok, true);
    const over = l.check('1.2.3.4', '/api/plan', T + 10_000);
    assert.equal(over.ok, false);
    assert.equal(over.retryAfterS, 50);
    assert.equal(l.stats.limited.expensive, 1);
    // A new window, a fresh count
    assert.equal(l.check('1.2.3.4', '/api/plan', T + 60_000).ok, true);
});

test('callers and tiers are counted apart', () => {
    const l = createLimiter({ tiers });
    for (let i = 0; i < 3; i++) l.check('1.2.3.4', '/api/plan', T);
    assert.equal(l.check('1.2.3.4', '/api/plan', T).ok, false);
    assert.equal(l.check('5.6.7.8', '/api/plan', T).ok, true, 'another phone is not affected');
    assert.equal(l.check('1.2.3.4', '/api/departures', T).ok, true, 'cheap reads still answer');
});

test('memory stays bounded however many addresses call', () => {
    const l = createLimiter({ tiers, maxKeys: 100 });
    for (let i = 0; i < 500; i++) l.check(`10.0.${i >> 8}.${i & 255}`, '/api/departures', T);
    for (let i = 0; i < 10; i++) l.check(`11.0.0.${i}`, '/api/departures', T + 61_000);
    assert.ok(l.size() <= 110);
});

test("the caller's address comes from the platform, never from what the caller writes", () => {
    assert.equal(clientIp({ 'do-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }, '10.0.0.1'), '203.0.113.9');
    assert.equal(clientIp({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.1'), '203.0.113.7');
    // Without those: the right-most public address our proxies appended, not what the caller wrote first
    assert.equal(clientIp({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 10.0.0.1' }, '10.0.0.1'), '203.0.113.5');
    assert.equal(clientIp({ 'x-forwarded-for': '10.0.0.2' }, '10.0.0.1'), '10.0.0.1');
    assert.equal(clientIp({}, '10.0.0.1'), '10.0.0.1');
});
