// Builds the SEQ timetable as one SQLite file, for the API to read in-process (Phase 0 of moving
// off a database server: see docs in the PR). Same source as scripts/ingest-gtfs.js.
//
//   node scripts/build-sqlite.js [--zip path/to/SEQ_GTFS.zip] [--out data/seq.sqlite] [--dist dist]
//
// With --dist, also writes what gets published (weekly, as a GitHub release, for the API to
// download; see lib/timetable-file.js): seq.sqlite.gz and manifest.json (version, checksum).
// The file is checked first (row counts, calendar far enough ahead): a bad feed publishes nothing.
//
// Layout, chosen for the API's lookups rather than mirroring GTFS:
//  - stops / trips get small integer keys (sid, tid); stop_times uses them, which keeps the
//    3.4M-row table small
//  - stop_times is stored clustered by (stop, departure time), so "what leaves this stop after
//    08:00" is one contiguous range read; a second index serves "this trip's stops in order"
//  - times are seconds after midnight of the service day (GTFS times pass 24:00)
//  - the per-stop route summaries the import precomputes in Postgres are computed here too
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const path = require('path');
const fetch = require('node-fetch');
const yauzl = require('yauzl-promise');
const { parse } = require('csv-parse');
const Database = require('better-sqlite3');

const GTFS_URL = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';
// The same checks as the Postgres import (scripts/ingest-gtfs.js)
const MIN_DAYS_AHEAD = 14;
const MIN_COUNTS = { routes: 300, trips: 50000, stops: 8000, stop_times: 1000000, calendar: 20 };

/** "YYYYMMDD" this many days from now, in Brisbane */
const brisbaneDate = (daysAhead) =>
    new Date(Date.now() + daysAhead * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }).replace(/-/g, '');

function check(db) {
    const problems = [];
    for (const [table, min] of Object.entries(MIN_COUNTS)) {
        const n = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
        console.log(`  ${table}: ${n.toLocaleString()}`);
        if (n < min) problems.push(`${table} has ${n} rows (expected at least ${min})`);
    }
    const end = db.prepare('SELECT max(end_date) e FROM calendar').get().e;
    const needed = brisbaneDate(MIN_DAYS_AHEAD);
    console.log(`  calendar runs to ${end} (needs ${needed} or later)`);
    if (!end || end < needed) problems.push(`calendar ends ${end}, before ${needed}`);
    if (problems.length) throw new Error(`The timetable failed its checks:\n - ${problems.join('\n - ')}`);
}

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

/** "25:15:00" -> 90900 */
const secs = (t) => {
    if (!t) return null;
    const [h, m, s] = t.split(':').map(Number);
    return h * 3600 + m * 60 + s;
};
const num = (v) => (v === '' || v == null ? null : Number(v));
const str = (v) => (v === '' || v == null ? null : v);

async function* rowsOf(entries, file) {
    const entry = entries.get(file);
    if (!entry) throw new Error(`${file} is missing from the GTFS zip`);
    const parser = (await entry.openReadStream()).pipe(parse({ columns: true, skip_empty_lines: true }));
    for await (const r of parser) yield r;
}

async function main() {
    const t0 = Date.now();
    const out = arg('--out') || path.join(__dirname, '..', 'data', 'seq.sqlite');
    let buffer;
    if (arg('--zip')) buffer = fs.readFileSync(arg('--zip'));
    else {
        console.log(`Downloading ${GTFS_URL}…`);
        const r = await fetch(GTFS_URL, { timeout: 120000 });
        if (!r.ok) throw new Error(`GTFS download failed: HTTP ${r.status}`);
        buffer = await r.buffer();
    }
    const zip = await yauzl.fromBuffer(buffer);
    const entries = new Map();
    for await (const e of zip) entries.set(e.filename, e);

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.building';
    fs.rmSync(tmp, { force: true });
    const db = new Database(tmp);
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('page_size = 4096');
    db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT,
            route_type INTEGER, route_color TEXT, route_text_color TEXT);
        CREATE TABLE calendar (service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER,
            thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date TEXT, end_date TEXT);
        CREATE TABLE calendar_dates (service_id TEXT, date TEXT, exception_type INTEGER);
        CREATE TABLE trips (tid INTEGER PRIMARY KEY, trip_id TEXT UNIQUE, route_id TEXT, service_id TEXT,
            trip_headsign TEXT, direction_id INTEGER, block_id TEXT, shape_id TEXT);
        CREATE TABLE stops (sid INTEGER PRIMARY KEY, stop_id TEXT UNIQUE, stop_code TEXT, stop_name TEXT,
            lat REAL, lon REAL, location_type INTEGER, parent_station TEXT, platform_code TEXT, suburb TEXT,
            servicing_routes TEXT, route_directions TEXT, route_types TEXT);
        CREATE TABLE stop_times (sid INTEGER, dep INTEGER, tid INTEGER, seq INTEGER, arr INTEGER,
            pickup_type INTEGER, drop_off_type INTEGER, PRIMARY KEY (sid, dep, tid)) WITHOUT ROWID;
    `);

    const insert = (sql) => db.prepare(sql);
    const tx = (fn) => db.transaction(fn);

    // Small tables
    const routes = new Map();
    const insRoute = insert('INSERT INTO routes VALUES (?,?,?,?,?,?)');
    const routeRows = [];
    for await (const r of rowsOf(entries, 'routes.txt')) {
        routes.set(r.route_id, r);
        routeRows.push([r.route_id, str(r.route_short_name), str(r.route_long_name), num(r.route_type), str(r.route_color), str(r.route_text_color)]);
    }
    tx(() => routeRows.forEach(r => insRoute.run(r)))();

    const cal = [];
    for await (const r of rowsOf(entries, 'calendar.txt'))
        cal.push([r.service_id, ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => num(r[d])), r.start_date, r.end_date]);
    const insCal = insert('INSERT INTO calendar VALUES (?,?,?,?,?,?,?,?,?,?)');
    tx(() => cal.forEach(r => insCal.run(r)))();
    const calDates = [];
    for await (const r of rowsOf(entries, 'calendar_dates.txt')) calDates.push([r.service_id, r.date, num(r.exception_type)]);
    const insCd = insert('INSERT INTO calendar_dates VALUES (?,?,?)');
    tx(() => calDates.forEach(r => insCd.run(r)))();

    const tripId = new Map();
    const trips = [];
    for await (const r of rowsOf(entries, 'trips.txt')) {
        const tid = trips.length + 1;
        tripId.set(r.trip_id, tid);
        trips.push({ tid, ...r });
    }
    const insTrip = insert('INSERT INTO trips VALUES (?,?,?,?,?,?,?,?)');
    tx(() => trips.forEach(t => insTrip.run(t.tid, t.trip_id, t.route_id, t.service_id, str(t.trip_headsign), num(t.direction_id), str(t.block_id), str(t.shape_id))))();

    const stopSid = new Map();
    const stops = [];
    for await (const r of rowsOf(entries, 'stops.txt')) {
        const sid = stops.length + 1;
        stopSid.set(r.stop_id, sid);
        stops.push({ sid, ...r });
    }
    console.log(`  routes ${routes.size}, trips ${trips.length}, stops ${stops.length} (${Date.now() - t0} ms)`);

    // stop_times: read all, sort by (stop, departure, trip) for the clustered key
    const st = [];
    for await (const r of rowsOf(entries, 'stop_times.txt')) {
        st.push([stopSid.get(r.stop_id), secs(r.departure_time), tripId.get(r.trip_id), num(r.stop_sequence), secs(r.arrival_time), num(r.pickup_type), num(r.drop_off_type)]);
    }
    st.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const insSt = insert('INSERT INTO stop_times VALUES (?,?,?,?,?,?,?)');
    tx(() => { for (const r of st) insSt.run(r); })();
    console.log(`  stop_times ${st.length} (${Date.now() - t0} ms)`);

    // Per-stop route summaries, as the Postgres import makes them
    const tripById = new Map(trips.map(t => [t.tid, t]));
    const perStop = new Map();   // sid -> Map(route_short_name -> { type, dirs:Set })
    for (const [sid, , tid] of st) {
        const t = tripById.get(tid);
        const r = routes.get(t.route_id);
        let m = perStop.get(sid);
        if (!m) perStop.set(sid, m = new Map());
        let e = m.get(r.route_short_name);
        if (!e) m.set(r.route_short_name, e = { type: num(r.route_type), dirs: new Set() });
        e.dirs.add(t.direction_id === '0' ? 'Inbound' : t.direction_id === '1' ? 'Outbound' : null);
    }
    const insStop = insert('INSERT INTO stops VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    tx(() => {
        for (const s of stops) {
            const m = perStop.get(s.sid);
            const names = m ? [...m.keys()] : null;
            insStop.run(s.sid, s.stop_id, str(s.stop_code), str(s.stop_name), num(s.stop_lat), num(s.stop_lon), num(s.location_type),
                str(s.parent_station), str(s.platform_code), str(s.suburb),
                names ? names.join(', ') : null,
                // Same order as Postgres gives: jsonb keys shortest first, DISTINCT arrays sorted (null last)
                m ? JSON.stringify(Object.fromEntries([...m].sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
                    .map(([k, v]) => [k, [...v.dirs].sort((a, b) => (a === null) - (b === null) || (a < b ? -1 : a > b ? 1 : 0))]))) : null,
                m ? JSON.stringify([...new Set([...m.values()].map(v => v.type))].sort((a, b) => a - b)) : null);
        }
    })();

    console.log(`Indexes… (${Date.now() - t0} ms)`);
    db.exec(`
        CREATE INDEX stop_times_trip ON stop_times (tid, seq);
        CREATE INDEX stops_code ON stops (stop_code);
        CREATE INDEX stops_parent ON stops (parent_station);
        CREATE INDEX trips_route ON trips (route_id, direction_id);
        CREATE INDEX calendar_dates_date ON calendar_dates (date);
    `);
    console.log('Checking…');
    check(db);
    const builtAt = new Date();
    // The version names the week's file: when it was built, in Brisbane ("20261115-0230")
    const version = builtAt.toLocaleString('sv-SE', { timeZone: 'Australia/Brisbane' }).replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
    const ins = db.prepare('INSERT INTO meta VALUES (?, ?)');
    ins.run('version', version);
    ins.run('built_at', builtAt.toISOString());
    ins.run('calendar_end', db.prepare('SELECT max(end_date) e FROM calendar').get().e);
    ins.run('feed_sha256', crypto.createHash('sha256').update(buffer).digest('hex'));
    db.exec('ANALYZE; VACUUM;');
    db.close();
    fs.renameSync(tmp, out);
    console.log(`✅ ${out}: version ${version}, ${(fs.statSync(out).size / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    const dist = arg('--dist');
    if (dist) {
        fs.mkdirSync(dist, { recursive: true });
        const gz = path.join(dist, 'seq.sqlite.gz');
        await pipeline(fs.createReadStream(out), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz));
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(gz)).digest('hex');
        const manifest = {
            region: 'seq', version, builtAt: builtAt.toISOString(),
            calendarEnd: new Database(out, { readonly: true }).prepare('SELECT max(end_date) e FROM calendar').get().e,
            file: 'seq.sqlite.gz', bytes: fs.statSync(gz).size, sha256
        };
        fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
        console.log(`📦 ${gz}: ${(manifest.bytes / 1048576).toFixed(0)} MB, manifest written`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
