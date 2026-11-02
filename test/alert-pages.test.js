const test = require('node:test');
const assert = require('node:assert/strict');
const { affectedStationNames, closureEnds, matchStations } = require('../lib/alertPages');
const pages = require('./fixtures/alert-pages-2026-11-02.json');

test('recorded: the stations a closure lists, in page order', () => {
    assert.deepEqual(affectedStationNames(pages[1171016]),
        ['Ipswich', 'Thomas St', 'Wulkaraka', 'Karrabin', 'Walloon', 'Thagoona', 'Rosewood']);
});

test('recorded: lists split by line are read whole, each station once', () => {
    const names = affectedStationNames(pages[1171286]);
    assert.equal(names.length, 10);
    assert.equal(names[0], 'Roma Street');
    assert.equal(names[9], 'Corinda');
    assert.ok(names.includes('Auchenflower'));
});

test('recorded: a page with no list still says where trains stop running', () => {
    assert.deepEqual(affectedStationNames(pages[500656]), []);
    assert.deepEqual(closureEnds(pages[500656]), ['Northgate', 'Shorncliffe']);
});

test('page names match our stations despite abbreviations and typos', () => {
    const stations = [
        { stop_id: 'place_ipssta', stop_name: 'Ipswich station' },
        { stop_id: 'place_thmsta', stop_name: 'Thomas Street station' },
        { stop_id: 'place_wulsta', stop_name: 'Wulkuraka station' },
        { stop_id: 'place_aucsta', stop_name: 'Auchenflower station' }
    ];
    assert.deepEqual(matchStations(['Ipswich', 'Thomas St', 'Wulkaraka', 'Nowhere'], stations).map(s => s.stop_id),
        ['place_ipssta', 'place_thmsta', 'place_wulsta']);
});
