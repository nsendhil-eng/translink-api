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
        { placeId: 7, displayName: '69, Ann Street', lat: -27.46, lon: 153.02, name: '69', address: 'Ann Street', kind: null });
    assert.ok(HOUSE_NUMBER_PREFIX.test('45 Station Rd'));
    assert.ok(HOUSE_NUMBER_PREFIX.test('3/20 Queen St'));
    assert.ok(!HOUSE_NUMBER_PREFIX.test('Suncorp Stadium'));
});

const { fromOverture, matchScore, mergePlaces } = require('../lib/places');

test('an Overture business: name, a kind in words, and its street address', () => {
    const r = fromOverture({ id: '08f1b2c3d4e5f6a7', name: 'Rochedale Central Dentist', category: 'dental_clinic',
        address: 'Shop 13/11 Lorisch Way', locality: 'Brisbane', lat: -27.5947, lon: 153.1236 });
    assert.equal(r.displayName, 'Rochedale Central Dentist, Shop 13/11 Lorisch Way, Brisbane');
    assert.equal(r.kind, 'Dentist');
    assert.ok(r.placeId < 0, 'never the same id as a Photon place');
    assert.equal(fromOverture({ id: 'x', name: 'Treasury', category: 'casino', address: '130 William St, Brisbane', locality: 'Brisbane', lat: 0, lon: 0 }).address,
        '130 William St, Brisbane');
    assert.equal(fromOverture({ id: 'y', name: 'A', category: 'real_estate_service', address: '1 A St', lat: 0, lon: 0 }).kind, 'Real estate');
});

test('match score: share of typed words that start a word of the name', () => {
    assert.equal(matchScore('rochedale cent', 'Rochedale Central Dentist'), 1);
    assert.equal(matchScore('pig n whistle', "Pig 'N' Whistle"), 1);
    assert.equal(matchScore('rochedale cent', 'Woolworths Rochedale CFC'), 0.5);
});

test('merged: best match first, Photon ahead on a tie, repeats dropped', () => {
    const at = (name, lat, lon, address = null) => ({ name, displayName: name, lat, lon, address });
    const photon = [at('Rochedale', -27.59, 153.12), at('Suncorp Stadium', -27.4648, 153.0095, '40 Castlemaine Street, Milton')];
    const overture = [
        at('Rochedale Central Dentist', -27.5947, 153.1236, 'Shop 13/11 Lorisch Way'),
        at('Suncorp Stadium', -27.4650, 153.0097, '40 Castlemaine St'),
        at('Bunnings Newstead', -27.4436, 153.0441, '142 Breakfast Creek Rd'),
        at('Bunnings Warehouse', -27.4437, 153.0442, '142 Breakfast Creek Road, Newstead')
    ];
    assert.ok(!mergePlaces('suncorp stad', [photon[1]], [at('Suncorp Bank', -27.47, 153.02)]).some(r => r.name === 'Suncorp Bank'));
    const chep = at('CHEP Rochedale Service Centre', -27.6, 153.13);
    assert.deepEqual(mergePlaces('rochedale cent', [photon[0], chep], overture).map(r => r.name).slice(0, 3),
        ['Rochedale Central Dentist', 'CHEP Rochedale Service Centre']);
    const stadium = mergePlaces('suncorp stadium', photon, overture).filter(r => r.name === 'Suncorp Stadium');
    assert.equal(stadium.length, 1);
    assert.equal(stadium[0], photon[1]);
    assert.equal(mergePlaces('bunnings', [], overture).filter(r => r.name.startsWith('Bunnings')).length, 1);
    assert.equal(mergePlaces('45 Station Rd', [at('45 Station Road', 0, 0)], [at('Station Cafe', 1, 1)])[0].name, '45 Station Road');
});
