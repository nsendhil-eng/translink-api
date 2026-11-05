// Address and place search for the planner and saved places ("Suncorp Stadium", "69 Ann St").
// Pure functions: turning Photon / Nominatim answers into the app's AddressResult shape
// ({ placeId, displayName, lat, lon }, displayName comma-separated, short name first).

// Greater SEQ, Gold Coast to Sunshine Coast: minLon,minLat,maxLon,maxLat
const SEQ_BBOX = '152.3,-28.4,153.6,-26.3';

// "45 Station Rd", "12a Smith St", "3/20 Queen St": public Photon is weak at exact house
// numbers, so those go to Nominatim (only when we're not running our own Photon)
const HOUSE_NUMBER_PREFIX = /^\d+[A-Za-z]?(\/\d+)?\s/;

// Transit stops are covered by the app's own stop search
function isTransitStop(p) {
    return (p.osm_key === 'highway' && p.osm_value === 'bus_stop') ||
        (p.osm_key === 'public_transport' && (p.osm_value === 'platform' || p.osm_value === 'stop_position'));
}

/** One Photon GeoJSON feature -> AddressResult, or null */
function fromPhoton(feature) {
    const p = feature?.properties;
    const c = feature?.geometry?.coordinates;
    if (!p || !c || c.length < 2 || isTransitStop(p)) return null;
    const area = p.district || p.locality;
    const displayName = [p.name, p.housenumber, p.street, area, p.city !== area ? p.city : null, p.state, p.postcode]
        .filter(s => s && String(s).trim()).join(', ');
    if (!displayName) return null;
    // osm_id is only unique per element type (node / way / relation): fold the type in
    const typeIndex = { N: 0, W: 1 }[p.osm_type] ?? 2;
    return { placeId: (p.osm_id ?? hash(displayName)) * 3 + typeIndex, displayName, lat: c[1], lon: c[0] };
}

/** One Nominatim result -> AddressResult */
const fromNominatim = (r) => ({ placeId: r.place_id, displayName: r.display_name, lat: Number(r.lat), lon: Number(r.lon) });

/** Photon often returns one place twice (a node and its building): first of each name, at most `max` */
function tidy(results, max = 6) {
    const seen = new Set();
    return results.filter(r => r && !seen.has(r.displayName) && seen.add(r.displayName)).slice(0, max);
}

function hash(s) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
}

module.exports = { SEQ_BBOX, HOUSE_NUMBER_PREFIX, isTransitStop, fromPhoton, fromNominatim, tidy };
