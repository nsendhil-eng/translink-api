// Address and place search for the planner and saved places ("Suncorp Stadium", "69 Ann St").
// Pure functions: turning Photon / Nominatim / Overture answers into the app's AddressResult shape
// ({ placeId, displayName, lat, lon }, displayName comma-separated, short name first), plus
// name / address / kind for showing a result on two lines ("Rochedale Central Dentist" /
// "Dentist · Shop 13/11 Lorisch Way, Brisbane").

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
    const street = [p.housenumber, p.street].filter(Boolean).join(' ') || null;
    const name = p.name || street || area || p.city;
    // "38 Cordelia Street, South Brisbane": the suburb says enough, the city only without one
    const address = [p.name ? street : null, area || p.city].filter(Boolean).join(', ') || null;
    return {
        placeId: (p.osm_id ?? hash(displayName)) * 3 + typeIndex, displayName, lat: c[1], lon: c[0],
        name, address, kind: photonKind(p)
    };
}

/** "Stadium", "Street", "Suburb"; null when OSM only says it's a building */
function photonKind(p) {
    if (p.osm_key === 'highway') return 'Street';
    if (p.osm_key === 'place') return ['house', 'building'].includes(p.osm_value) ? 'Address' : 'Suburb';
    if (!p.name && p.housenumber) return 'Address';
    if (p.osm_value in PHOTON_KINDS) return PHOTON_KINDS[p.osm_value];
    return p.osm_value ? humanize(p.osm_value) : null;
}

// OSM tags that read badly as words; null: says nothing worth showing
const PHOTON_KINDS = {
    yes: null, building: null, house: null, residential: null, commercial: null, construction: null, outpost: 'Shop',
    doityourself: 'Hardware', hardware: 'Hardware', retail: 'Shopping', mall: 'Shopping centre', parking: 'Car park',
    fast_food: 'Fast food', bus_station: 'Bus station', station: 'Station', ferry_terminal: 'Ferry terminal'
};

// Overture's basic categories that read badly turned straight into words
const OVERTURE_KINDS = {
    dental_clinic: 'Dentist', animal_or_pet_service: 'Vet or pet service', outpatient_care_facility: 'Medical centre',
    primary_care_or_general_clinic: 'Doctor', hardware_home_and_garden_store: 'Hardware and garden',
    food_and_beverage_store: 'Food and drink shop', fashion_and_apparel_store: 'Clothing', casual_eatery: 'Eatery',
    fast_food_restaurant: 'Fast food', stadium_arena: 'Stadium', place_of_learning: 'School',
    personal_or_beauty_service: 'Beauty', bank_or_credit_union: 'Bank', pharmacy_and_drug_store: 'Pharmacy',
    public_transit_facility_or_service: 'Transport', shopping_mall: 'Shopping centre', lodging: 'Accommodation',
    vision_or_eye_care_clinic: 'Optometrist', diagnostics_imaging_or_lab_service: 'Imaging and pathology',
    gas_station: 'Petrol station', parking: 'Car park'
};

function humanize(key) {
    const s = String(key).replace(/_/g, ' ').replace(/ (service|or service)$/, '').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : null;
}

/** One row of the `places` table (Overture) -> AddressResult; negative ids never meet Photon's */
function fromOverture(row) {
    const address = row.address && row.locality && !row.address.toLowerCase().includes(row.locality.toLowerCase())
        ? `${row.address}, ${row.locality}` : (row.address || row.locality || null);
    const id = parseInt(String(row.id).replace(/[^0-9a-f]/gi, '').slice(0, 12), 16);
    return {
        placeId: -(Number.isFinite(id) && id > 0 ? id : hash(String(row.id)) + 1),
        displayName: [row.name, address].filter(Boolean).join(', '),
        lat: Number(row.lat), lon: Number(row.lon),
        name: row.name, address, kind: row.category ? (OVERTURE_KINDS[row.category] || humanize(row.category)) : null
    };
}

// --- Merging Photon and Overture --------------------------------------------------------

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** How much of the query the name covers: share of query words that start a word of the name */
function matchScore(q, name) {
    const qw = words(q), nw = words(name);
    if (!qw.length) return 0;
    return qw.filter(w => nw.some(n => n.startsWith(w))).length / qw.length;
}

/**
 * For ordering: every typed word found counts most; then a name that starts with what was typed
 * ("Rochedale Central Dentist" for "rochedale cent", not "CHEP Rochedale Service Centre"); then
 * names with fewer other words.
 */
function rankScore(q, name) {
    const nw = words(name);
    const typed = words(q).join(' ');
    const starts = nw.join(' ').startsWith(typed) ? 0.5 : 0;
    const used = nw.length ? words(q).filter(w => nw.some(n => n.startsWith(w))).length / nw.length : 0;
    return matchScore(q, name) + starts + 0.2 * Math.min(1, used);
}

const ROAD_WORDS = { road: 'rd', street: 'st', avenue: 'ave', drive: 'dr', place: 'pl', parade: 'pde', terrace: 'tce', highway: 'hwy', court: 'ct', lane: 'ln', boulevard: 'blvd' };
const sameAddressKey = (a) => words(a).map(w => ROAD_WORDS[w] || w).join(' ');

function metresBetween(a, b) {
    const dLat = (a.lat - b.lat) * 111_320, dLon = (a.lon - b.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dLat, dLon);
}

/** One place twice: the same name close by, or the same street address next door */
function isRepeat(a, b) {
    const d = metresBetween(a, b);
    if (d < 300 && words(a.name).join(' ') === words(b.name).join(' ')) return true;
    if (d < 120 && a.address && b.address) {
        const ka = sameAddressKey(a.address.split(',')[0]), kb = sameAddressKey(b.address.split(',')[0]);
        // "142 Breakfast Creek Rd" twice (Bunnings Newstead, Bunnings Warehouse); not a shared mall address
        return ka === kb && /^\d/.test(ka) && matchScore(a.name, b.name) > 0;
    }
    return false;
}

/**
 * Photon (addresses, streets, landmarks) and Overture (businesses) as one list, best match to
 * the typed words first (rankScore); on a tie Photon's order leads, then Overture's (nearest strong matches).
 * A house-number query ("45 Station Rd") is an address: Photon first.
 */
function mergePlaces(q, photon, overture, max = 6) {
    const address = HOUSE_NUMBER_PREFIX.test(q);
    const scored = [...photon.map((r, i) => ({ r, src: 0, i })), ...overture.map((r, i) => ({ r, src: 1, i }))]
        .filter(x => x.r)
        .map(x => ({ ...x, score: address ? (x.src === 0 ? 1 : 0) : rankScore(q, x.r.name || x.r.displayName) }));
    scored.sort((a, b) => b.score - a.score || a.src - b.src || a.i - b.i);
    // With places that have every typed word, half-matches are noise ("Suncorp Bank" for "suncorp stad")
    const full = !address && scored.some(x => matchScore(q, x.r.name || x.r.displayName) === 1);
    const out = [];
    for (const { r } of scored) {
        if (out.length >= max) break;
        if (full && matchScore(q, r.name || r.displayName) < 1) continue;
        if (!out.some(o => isRepeat(o, r))) out.push(r);
    }
    return out;
}

/** One Nominatim result -> AddressResult ("69, Ann Street, Brisbane City, …": first part is the name) */
function fromNominatim(r) {
    const parts = String(r.display_name || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
        placeId: r.place_id, displayName: r.display_name, lat: Number(r.lat), lon: Number(r.lon),
        name: parts[0] || null, address: parts.slice(1, 3).join(', ') || null, kind: null
    };
}

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

module.exports = { SEQ_BBOX, HOUSE_NUMBER_PREFIX, isTransitStop, fromPhoton, fromNominatim, fromOverture, tidy, matchScore, mergePlaces };
