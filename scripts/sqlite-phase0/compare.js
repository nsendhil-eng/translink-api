// Phase 0: the same questions to Postgres (live Neon) and the SQLite file; are the answers the
// same, and how long does each take?
//
//   node scripts/sqlite-phase0/compare.js [data/seq.sqlite]
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { Timetable } = require('../../lib/sqlite-data');
const { activeServiceDays } = require('../../lib/realtime');

const PLACES = {
    'Toowong (Sylvan Rd)': [-27.4838, 152.9937],
    'Roma Street': [-27.4658, 153.0195],
    'CBD (Queen St Mall)': [-27.4698, 153.0251],
    'South Bank': [-27.4766, 153.0203],
    'Pullenvale': [-27.5000, 152.9200],
    'Rochedale': [-27.5947, 153.1236],
    'Surfers Paradise': [-28.0023, 153.4310],
    'Maroochydore': [-26.6590, 153.0870],
    'Ipswich': [-27.6140, 152.7590],
    'Cleveland': [-27.5260, 153.2650]
};

const STOP_SQL = `
  SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
         parent_stop.stop_name AS parent_station_name, ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric)::int AS distance_m,
         ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
  FROM stops AS s LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id`;

/** The Postgres stops-near-me, as index.js does it (no type filter) */
async function pgStopsNearMe(pool, lat, lon, radius, farRadius) {
    const { rows } = await pool.query(`${STOP_SQL}
        WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
        ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 25`, [lon, lat, radius]);
    if (farRadius > radius) {
        const { rows: far } = await pool.query(`${STOP_SQL}
            WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
              AND s.location_type = 0 AND s.route_types && $4
            ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 15`, [lon, lat, farRadius, [2, 4]]);
        const have = new Set(rows.map(r => r.id));
        for (const s of far) if (!have.has(s.id)) rows.push(s);
    }
    const parents = [...new Set(rows.map(r => r.parent_station).filter(Boolean))];
    if (parents.length) {
        const have = new Set(rows.map(r => r.id));
        const { rows: sib } = await pool.query(`${STOP_SQL} WHERE s.parent_station = ANY($3)`, [lon, lat, parents]);
        for (const s of sib) if (!have.has(s.id)) rows.push(s);
        rows.sort((a, b) => a.distance_m - b.distance_m);
    }
    return rows;
}

const servicesRunningOn = (dayOfWeek) => `(
    (SELECT service_id FROM calendar WHERE start_date <= $1 AND end_date >= $1 AND ${dayOfWeek} = 1)
    EXCEPT (SELECT service_id FROM calendar_dates WHERE date = $1 AND exception_type = 2)
    UNION (SELECT service_id FROM calendar_dates WHERE date = $1 AND exception_type = 1))`;
const depSql = (day) => `
    SELECT st.trip_id, s.stop_id, s.stop_name, st.stop_sequence, st.departure_time, s.platform_code,
           t.trip_headsign, t.direction_id, t.shape_id, r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
           r.route_type, ST_Y(s.location::geometry) AS stop_lat, ST_X(s.location::geometry) AS stop_lon
    FROM stop_times AS st JOIN trips AS t ON st.trip_id = t.trip_id JOIN routes AS r ON t.route_id = r.route_id
    JOIN stops s ON st.stop_id = s.stop_id
    WHERE s.stop_code = ANY($3::text[]) AND st.departure_time >= $2 AND t.service_id IN ${servicesRunningOn(day.dayOfWeek)}`;

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const ms = (ns) => Number(ns) / 1e6;

async function main() {
    const file = process.argv[2] || 'data/seq.sqlite';
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 4 });
    const tOpen = process.hrtime.bigint();
    const tt = new Timetable(file);
    console.log(`SQLite: opened and loaded ${tt.stops.length} stops in ${ms(process.hrtime.bigint() - tOpen).toFixed(0)} ms; built ${tt.meta.built_at}`);
    const pgStops = (await pool.query('SELECT count(*)::int n FROM stop_times')).rows[0].n;
    const sqStops = tt.db.prepare('SELECT count(*) n FROM stop_times').get().n;
    console.log(`stop_times rows: Postgres ${pgStops}, SQLite ${sqStops}${pgStops === sqStops ? '' : '  (different feed weeks: some trips differ)'}`);

    const days = activeServiceDays(new Date());
    const report = [];
    let mismatches = 0;
    for (const [name, [lat, lon]] of Object.entries(PLACES)) {
        // Stops near me: 500 m, trains and ferries to 1.2 km (as the app asks)
        const p = await pgStopsNearMe(pool, lat, lon, 500, 1200);
        const s = tt.stopsNearMe({ lat, lon, radius: 500, farRadius: 1200 });
        const key = (r) => `${r.id}|${r.distance_m}|${r.parent_station_name}|${JSON.stringify(r.route_types)}|${JSON.stringify(r.route_directions)}`;
        const pk = p.map(key).sort(), sk = s.map(key).sort();
        const stopDiff = pk.filter(k => !sk.includes(k)).concat(sk.filter(k => !pk.includes(k)).map(k => '+' + k));
        // Departures for those stops' codes
        const codes = [...new Set(s.map(r => r.stop_code).filter(Boolean))];
        let pgDeps = [], sqDeps = [];
        for (const d of days) {
            pgDeps.push(...(await pool.query(depSql(d), [d.dateString, d.fromTime, codes])).rows.map(r => ({ ...r, day: d.dateString })));
            sqDeps.push(...tt.scheduledDepartures(codes, d).map(r => ({ ...r, day: d.dateString })));
        }
        const dk = (r) => `${r.day}|${r.trip_id}|${r.stop_id}|${r.stop_sequence}|${r.departure_time}|${r.route_short_name}|${r.trip_headsign}`;
        const pSet = new Set(pgDeps.map(dk)), sSet = new Set(sqDeps.map(dk));
        const onlyPg = [...pSet].filter(k => !sSet.has(k)), onlySq = [...sSet].filter(k => !pSet.has(k));
        // Feed-week differences: trips that exist on one side only
        const sqTrip = tt.db.prepare('SELECT 1 FROM trips WHERE trip_id = ?');
        const realOnlyPg = onlyPg.filter(k => sqTrip.get(k.split('|')[1]));
        const pgTripIds = new Set((await pool.query('SELECT trip_id FROM trips WHERE trip_id = ANY($1)', [onlySq.map(k => k.split('|')[1])])).rows.map(r => r.trip_id));
        const realOnlySq = onlySq.filter(k => pgTripIds.has(k.split('|')[1]));
        const bad = stopDiff.length + realOnlyPg.length + realOnlySq.length;
        mismatches += bad;
        report.push({ place: name, stops: `${p.length}/${s.length}`, stopDiffs: stopDiff.length, departures: `${pgDeps.length}/${sqDeps.length}`,
            feedWeekOnly: onlyPg.length + onlySq.length - realOnlyPg.length - realOnlySq.length, realDiffs: realOnlyPg.length + realOnlySq.length });
        if (stopDiff.length) console.log(name, 'stop differences', stopDiff.slice(0, 6));
        if (realOnlyPg.length || realOnlySq.length) console.log(name, 'departure differences', realOnlyPg.slice(0, 3), realOnlySq.slice(0, 3));
    }
    console.table(report);
    console.log(mismatches ? `❌ ${mismatches} real differences` : '✅ Same answers (apart from trips that differ between feed weeks)');

    // --- Speed --------------------------------------------------------------------------
    // SQLite in-process: many calls, warm
    const names = Object.keys(PLACES);
    const sqNear = [], sqDep = [];
    const cpu0 = process.cpuUsage();
    const N = 300;
    for (let i = 0; i < N; i++) {
        const [lat, lon] = PLACES[names[i % names.length]];
        let t = process.hrtime.bigint();
        const s = tt.stopsNearMe({ lat, lon, radius: 500, farRadius: 1200 });
        sqNear.push(ms(process.hrtime.bigint() - t));
        const codes = [...new Set(s.map(r => r.stop_code).filter(Boolean))];
        t = process.hrtime.bigint();
        for (const d of days) tt.scheduledDepartures(codes, d);
        sqDep.push(ms(process.hrtime.bigint() - t));
    }
    const cpu = process.cpuUsage(cpu0);
    console.log(`\nSQLite (${N} home-screen loads, in-process):`);
    console.log(`  stops near me   median ${pct(sqNear, 0.5).toFixed(3)} ms   slowest 1% ${pct(sqNear, 0.99).toFixed(3)} ms`);
    console.log(`  departures      median ${pct(sqDep, 0.5).toFixed(2)} ms   slowest 1% ${pct(sqDep, 0.99).toFixed(2)} ms`);
    console.log(`  CPU per load    ${((cpu.user + cpu.system) / 1000 / N).toFixed(2)} ms`);
    console.log(`  memory (RSS)    ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB, with the Postgres client loaded too`);

    // Postgres: time inside the database (EXPLAIN ANALYZE), which excludes the network
    const pgNear = [], pgDep = [];
    for (const name of names) {
        const [lat, lon] = PLACES[name];
        const e1 = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${STOP_SQL}
            WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
            ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 25`, [lon, lat, 500])).rows[0]['QUERY PLAN'][0];
        pgNear.push(e1['Execution Time'] + e1['Planning Time']);
        const codes = [...new Set(tt.stopsNearMe({ lat, lon, radius: 500, farRadius: 1200 }).map(r => r.stop_code).filter(Boolean))];
        let total = 0;
        for (const d of days) {
            const e = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${depSql(d)}`, [d.dateString, d.fromTime, codes])).rows[0]['QUERY PLAN'][0];
            total += e['Execution Time'] + e['Planning Time'];
        }
        pgDep.push(total);
    }
    console.log(`\nPostgres (inside Neon, warm, no network; the API adds a network round trip per query, 3 for stops):`);
    console.log(`  stops near me (first of 3 queries)  median ${pct(pgNear, 0.5).toFixed(2)} ms   slowest ${Math.max(...pgNear).toFixed(2)} ms`);
    console.log(`  departures                          median ${pct(pgDep, 0.5).toFixed(2)} ms   slowest ${Math.max(...pgDep).toFixed(2)} ms`);
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
