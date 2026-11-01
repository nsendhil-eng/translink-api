const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineMeters, headingAlongShape, geojsonToLatLon } = require('../lib/geo');
const { cleanAlertText, alertWindow, routeCode } = require('../lib/alerts');

// --- Geo ------------------------------------------------------------------------

test('haversine: Roma Street to Central is about 750 m', () => {
    const d = haversineMeters(-27.4655, 153.0189, -27.4660, 153.0262);
    assert.ok(d > 700 && d < 800, `got ${d}`);
});

// A street running east from (lat, lon), about 10 m per 0.0001°
const east = [[-27.48, 152.990], [-27.48, 152.991], [-27.48, 152.992]];

test('heading follows the shape the vehicle sits on', () => {
    assert.equal(headingAlongShape(east, -27.48003, 152.9905).heading, 90);
    assert.equal(headingAlongShape([...east].reverse(), -27.48003, 152.9905).heading, 270);
});

test('no heading when the vehicle is far from its route', () => {
    assert.equal(headingAlongShape(east, -27.483, 152.9905), null);   // ~330 m off
    assert.equal(headingAlongShape([east[0]], -27.48, 152.99), null);
});

test('out-and-back shape: the pass just before the next stop wins', () => {
    // East along the street, then back west along the same street
    const outAndBack = [...east, [-27.48001, 152.991], [-27.48001, 152.990]];
    const nextStopOnReturn = [-27.48001, 152.9902];
    assert.equal(headingAlongShape(outAndBack, -27.48, 152.9905, nextStopOnReturn).heading, 270);
});

test('GeoJSON shapes become [lat, lon] lists', () => {
    assert.deepEqual(geojsonToLatLon('{"type":"LineString","coordinates":[[153,-27],[153.1,-27.1]]}'), [[-27, 153], [-27.1, 153.1]]);
    assert.deepEqual(geojsonToLatLon({ type: 'MultiLineString', coordinates: [[[1, 2]], [[3, 4]]] }), [[2, 1], [4, 3]]);
    assert.deepEqual(geojsonToLatLon('not json'), []);
});

// --- Alerts -----------------------------------------------------------------------

test('alert text: run-together sentences are split, Mac/Mc names kept', () => {
    assert.equal(cleanAlertText('Buses will divert in briefStart: 11:30pmEnd: 4am'), 'Buses will divert in brief\nStart: 11:30pm\nEnd: 4am');
    assert.equal(cleanAlertText('Stop on MacGregor Tce and McDowall St'), 'Stop on MacGregor Tce and McDowall St');
});

test('route codes drop the timetable version', () => {
    assert.equal(routeCode('BRIP-4997'), 'BRIP');
    assert.equal(routeCode('412-5146'), '412');
});

const NOW = 1_793_524_000;
const alert = (effect, periods) => ({ effect, periods });

test('alert windows: active, upcoming, and irrelevant', () => {
    assert.equal(alertWindow(alert('DETOUR', [{ start: NOW - 60, end: NOW + 60 }]), NOW).status, 'active');
    const up = alertWindow(alert('DETOUR', [{ start: NOW + 3600, end: NOW + 7200 }]), NOW);
    assert.equal(up.status, 'upcoming');
    assert.equal(up.priority, 75, 'upcoming ranks a little below active');
    assert.equal(alertWindow(alert('DETOUR', [{ start: NOW + 3 * 86400, end: null }]), NOW), null);
    assert.equal(alertWindow(alert('DETOUR', [{ start: NOW - 7200, end: NOW - 3600 }]), NOW), null);
});

test('alert windows: open-ended delay alerts expire after 12 h, long-running ones sink', () => {
    assert.equal(alertWindow(alert('SIGNIFICANT_DELAYS', [{ start: NOW - 13 * 3600, end: null }]), NOW), null);
    assert.ok(alertWindow(alert('SIGNIFICANT_DELAYS', [{ start: NOW - 3600, end: null }]), NOW));
    const old = alertWindow(alert('NO_SERVICE', [{ start: NOW - 40 * 86400, end: NOW + 86400 }]), NOW);
    assert.equal(old.longRunning, true);
    assert.equal(old.priority, 50);
});
