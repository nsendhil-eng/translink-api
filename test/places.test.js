const test = require('node:test');
const assert = require('node:assert/strict');
const { fromPhoton, fromNominatim, tidy, HOUSE_NUMBER_PREFIX } = require('../lib/places');

const feature = (props, coords = [153.0228, -27.4692]) => ({ geometry: { coordinates: coords }, properties: props });

test('a Photon place becomes a comma-separated address, name first', () => {
    const r = fromPhoton(feature({
        osm_type: 'W', osm_id: 100, osm_key: 'building', osm_value: 'yes', name: 'Northbank Plaza',
        housenumber: '69', street: 'Ann Street', district: 'Brisbane City', city: 'Brisbane', state: 'Queensland', postcode: '4000'
    }));
    assert.equal(r.displayName, 'Northbank Plaza, 69, Ann Street, Brisbane City, Brisbane, Queensland, 4000');
    assert.deepEqual([r.lat, r.lon, r.placeId], [-27.4692, 153.0228, 301]);
});

test('bus stops and platforms are left to the app\'s stop search', () => {
    assert.equal(fromPhoton(feature({ osm_key: 'highway', osm_value: 'bus_stop', name: 'Stop 9' })), null);
    assert.equal(fromPhoton(feature({ osm_key: 'public_transport', osm_value: 'platform', name: 'Platform 2' })), null);
    assert.equal(fromPhoton({ properties: { name: 'No geometry' } }), null);
});

test('duplicates (a node and its building) collapse, and results are capped', () => {
    const a = { placeId: 1, displayName: 'Suncorp Stadium, Milton', lat: 0, lon: 0 };
    assert.deepEqual(tidy([a, { ...a, placeId: 2 }, null, { ...a, displayName: 'X' }], 6).map(r => r.placeId), [1, 1]);
    assert.equal(tidy(Array.from({ length: 9 }, (_, i) => ({ displayName: String(i) })), 6).length, 6);
});

test('Nominatim results and house-number queries', () => {
    assert.deepEqual(fromNominatim({ place_id: 7, display_name: '69, Ann Street', lat: '-27.46', lon: '153.02' }),
        { placeId: 7, displayName: '69, Ann Street', lat: -27.46, lon: 153.02 });
    assert.ok(HOUSE_NUMBER_PREFIX.test('45 Station Rd'));
    assert.ok(HOUSE_NUMBER_PREFIX.test('3/20 Queen St'));
    assert.ok(!HOUSE_NUMBER_PREFIX.test('Suncorp Stadium'));
});
