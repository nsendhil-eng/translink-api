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
    return out;
}

const norm = (path, body) => {
    if (!Array.isArray(body)) return body;
    if (path.startsWith('/api/departures')) return body.map(pick).map(o => JSON.stringify(o)).sort();
    return body.map(o => JSON.stringify(o)).sort();
};

(async () => {
    const list = await requests();
    let same = 0, differ = 0;
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
