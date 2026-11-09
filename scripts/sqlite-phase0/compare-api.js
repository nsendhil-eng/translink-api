// Phase 2 check: the same requests to two copies of the API, one on Postgres and one on the
// SQLite file; the answers must match. Start them first, e.g.
//   TIMETABLE_SOURCE=postgres PORT=3021 node index.js &
//   TIMETABLE_FILE=data/seq.sqlite PORT=3022 node index.js &
//   node scripts/sqlite-phase0/compare-api.js 3021 3022 [endpoint-group]
const fetch = require('node-fetch');
const [pgPort, sqPort, group = 'home'] = process.argv.slice(2);

const PLACES = [[-27.4838, 152.9937], [-27.4658, 153.0195], [-27.4698, 153.0251], [-27.4766, 153.0203], [-27.5, 152.92],
    [-27.5947, 153.1236], [-28.0023, 153.431], [-26.659, 153.087], [-27.614, 152.759], [-27.526, 153.265],
    [-27.4386, 153.0420], [-27.3820, 153.1220], [-27.5520, 153.0560], [-28.1660, 153.5050], [-26.4000, 153.0400]];

// Realtime differs between two processes by a few seconds, so compare what the timetable decides
const STABLE = ['trip_id', 'stop_id', 'stop_sequence', 'stopName', 'vehicleType', 'routeNumber', 'routeId', 'directionId',
    'headsign', 'scheduledDepartureUtc', 'routeLongName', 'routeColor', 'routeTextColor', 'platformCode', 'shapeId', 'heading', 'isLastStop'];
const pick = (o) => Object.fromEntries(STABLE.filter(k => k in o).map(k => [k, o[k]]));

async function requests() {
    const out = [];
    if (group === 'home') {
        for (const [lat, lon] of PLACES) {
            out.push(`/api/stops-near-me?lat=${lat}&lon=${lon}&radius=500&far_radius=1200`);
            out.push(`/api/stops-near-me?lat=${lat}&lon=${lon}&radius=3000`);
            out.push(`/api/stops-near-me?lat=${lat}&lon=${lon}&radius=800&types=2,4`);
            const stops = await (await fetch(`http://localhost:${pgPort}/api/stops-near-me?lat=${lat}&lon=${lon}&radius=500&far_radius=1200`)).json();
            const codes = [...new Set(stops.map(s => s.stop_code).filter(Boolean))].join(',');
            if (!codes) continue;
            out.push(`/api/departures?stops=${codes}&with_heading=1&per_route=3&lat=${lat}&lon=${lon}`);
            out.push(`/api/departures?stops=${codes}&per_stop=2`);
            out.push(`/api/departures?stops=${codes}`);
            const ids = stops.slice(0, 3).map(s => s.id).join(',');
            out.push(`/api/departures?stops=${codes}&get_off_stop=${ids}`);
        }
        out.push('/api/departures');                       // the web board's default stops
        out.push('/api/departures?stops=');
    }
    if (group === 'all') {
        const get = async (p) => (await fetch(`http://localhost:${pgPort}${p}`)).json();
        const routes = new Map(), stopIds = new Set(), codes = new Set(), shapes = new Set();
        const trips = new Map();
        for (const [lat, lon] of PLACES) {
            const stops = await get(`/api/stops-near-me?lat=${lat}&lon=${lon}&radius=800&far_radius=1500`);
            if (!Array.isArray(stops) || !stops.length) continue;
            stops.forEach(s => { stopIds.add(s.id); if (s.stop_code) codes.add(s.stop_code); });
            const c = stops.map(s => s.stop_code).filter(Boolean).slice(0, 12).join(',');
            out.push(`/api/routes-for-stops?stop_codes=${c}`);
            out.push(`/api/shapes-near-me?lat=${lat}&lon=${lon}`);
            out.push(`/api/alerts?stop_ids=${stops.slice(0, 5).map(s => s.id).join(',')}`);
            out.push(`/api/alerts/all?lat=${lat}&lon=${lon}`);
            const deps = await get(`/api/departures?stops=${c}&per_stop=3`);
            for (const d of Array.isArray(deps) ? deps.slice(0, 12) : []) {
                trips.set(d.trip_id, d);
                routes.set(`${d.routeId}|${d.directionId}`, d);
                if (d.shapeId) shapes.add(d.shapeId);
            }
            const [d] = Array.isArray(deps) ? deps : [];
            if (d) out.push(`/api/trip-stops?route_id=${encodeURIComponent(d.routeId)}&direction_id=${d.directionId}&user_lat=${lat}&user_lon=${lon}`);
        }
        for (const [id, d] of trips) {
            const t = encodeURIComponent(id);
            out.push(`/api/trip-stops?trip_id=${t}`, `/api/trip-stops?trip_id=${t}&user_lat=-27.47&user_lon=153.02`);
            out.push(`/api/trip-details?trip_id=${t}&stop_sequence=${d.stop_sequence}`);
            out.push(`/api/next-trips?route_id=${encodeURIComponent(d.routeId)}&direction_id=${d.directionId}&stop_id=${encodeURIComponent(d.stop_id)}`);
        }
        for (const [, d] of routes) {
            const q = `route_id=${encodeURIComponent(d.routeId)}&headsign=${encodeURIComponent(d.headsign)}`;
            out.push(`/api/stops-for-route?${q}`, `/api/route-info?route_id=${encodeURIComponent(d.routeId)}`);
            out.push(`/api/trip-stops?route_id=${encodeURIComponent(d.routeId)}&direction_id=${d.directionId}`);
            out.push(`/api/alerts?route_ids=${encodeURIComponent(d.routeId)}`);
            out.push(`/api/stops-for-route-at-station?${q}&parent_station=place_romsta`);
        }
        const list = [...shapes];
        for (const id of list) out.push(`/api/route-shape?shape_id=${encodeURIComponent(id)}`);
        for (let i = 0; i < list.length; i += 20) out.push(`/api/shapes?ids=${list.slice(i, i + 20).map(encodeURIComponent).join(',')}`);
        const ids = [...stopIds];
        for (let i = 0; i < Math.min(ids.length, 200); i += 2) out.push(`/api/stop-live?stop_ids=${ids[i]}`);
        out.push('/api/route-info?route_id=nope', '/api/route-shape?shape_id=nope', '/api/trip-stops?trip_id=nope', '/api/trip-details?trip_id=nope&stop_sequence=1',
            '/api/routes-for-stops?stop_codes=nope', '/api/stops-for-route?route_id=nope&headsign=nope');
    }
    if (group === 'search') {
        const WORDS = ['roma', 'ann st', 'stop 10 ann', 'south bank', 'indooroopilly', 'cultural', 'garden city', 'chermside', '412', '66', 'M1', 'BT', 'G:link',
            'ferry', 'city', 'university', 'UQ Lakes', 'airport', 'Coronation', 'Helensvale', 'Nambour', 'Toowoomba', 'Ipswich', '100%', 'a_b', '(x', 'zzzznothing', 'Maroochy', 'Queen St', 'Eagle St', 'Brisbane', 'Station'];
        for (const w of WORDS) {
            const q = encodeURIComponent(w);
            if (w.length >= 3) out.push(`/api/search?q=${q}`);
            out.push(`/api/v2/search?q=${q}`, `/api/v2/search?q=${q}&lat=-27.47&lon=153.02`, `/api/v2/search?q=${q}&lat=-28.0&lon=153.43`);
        }
    }
    return out;
}

// Times and vehicles move between the two requests; what's compared is what the timetable decides
const LIVE = new Set(['secondsUntil', 'estimatedTime', 'estimatedUtc', 'isRealtime', 'delaySeconds', 'departureUtc', 'vehicle', 'ageSeconds',
    'isCancelled', 'isUpcoming', 'isSkipped', 'hasPassed']);
const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => !LIVE.has(k)).map(k => [k, stable(v[k])])) : v;
// Postgres picks any shape for a route + headsign (DISTINCT ON without a tie-break)
const noShape = (o) => { const { shape_id, ...rest } = o; return rest; };
const strs = (a) => a.map(o => JSON.stringify(stable(o))).sort();

const norm = (path, body) => {
    if (path.startsWith('/api/search') || path.startsWith('/api/v2/search')) {
        return Array.isArray(body?.stops) ? [...strs(body.stops), ...strs(body.routes.map(noShape))] : body;
    }
    if (path.startsWith('/api/shapes-near-me') && Array.isArray(body)) return body.map(r => r.routeId).sort();
    if (path.startsWith('/api/stop-live')) return (body.trips || []).map(t => JSON.stringify(stable(t)));
    if (path.startsWith('/api/alerts')) return strs((body.alerts || []));
    if (path.startsWith('/api/next-trips')) return strs(body.trips || []);
    if (!Array.isArray(body)) return JSON.stringify(stable(body));
    if (path.startsWith('/api/departures')) return body.map(pick).map(o => JSON.stringify(o)).sort();
    return strs(body);
};

(async () => {
    const list = await requests();
    let same = 0, differ = 0;
    console.log(`${list.length} requests`);
    const ask = (path) => Promise.all([pgPort, sqPort].map(p => fetch(`http://localhost:${p}${path}`).then(async r => ({ status: r.status, body: await r.json() }))));
    for (const path of list) {
        // Live data differs between the two copies for a few seconds at a time: a difference
        // that goes away when asked again is timing; one that stays is the timetable
        let a, b, na, nb, tries = 0;
        do {
            if (tries) await new Promise(r => setTimeout(r, 4000));
            [a, b] = await ask(path);
            na = norm(path, a.body); nb = norm(path, b.body);
        } while (++tries < 4 && !(a.status === b.status && JSON.stringify(na) === JSON.stringify(nb)));
        if (a.status === b.status && JSON.stringify(na) === JSON.stringify(nb)) { same++; continue; }
        differ++;
        const onlyA = Array.isArray(na) ? na.filter(x => !nb.includes(x)) : [JSON.stringify(na)];
        const onlyB = Array.isArray(nb) ? nb.filter(x => !na.includes(x)) : [JSON.stringify(nb)];
        console.log(`✗ ${path}\n   status ${a.status}/${b.status}, rows ${na.length}/${nb.length}`);
        onlyA.slice(0, 2).forEach(x => console.log('   postgres only:', x.slice(0, 220)));
        onlyB.slice(0, 2).forEach(x => console.log('   sqlite only:  ', x.slice(0, 220)));
    }
    console.log(`\n${same} of ${list.length} requests gave the same answer${differ ? `, ${differ} differ` : ''}`);
    process.exit(differ ? 1 : 0);
})();
