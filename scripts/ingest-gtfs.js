// scripts/ingest-gtfs.js — load Translink's SEQ timetable (GTFS) into Postgres.
//
//   node scripts/ingest-gtfs.js            load, check, swap in
//   node scripts/ingest-gtfs.js --dry-run  load and check only; the live tables are untouched
//
// Runs weekly from GitHub Actions (.github/workflows/weekly-gtfs.yml). Load-and-swap, so the API
// never sees a half-loaded timetable:
//   1. everything is built in a separate schema, gtfs_new, while the live tables keep serving
//   2. checks: enough routes, trips, stops and stop times, and the calendar runs at least
//      MIN_DAYS_AHEAD days ahead (the database ran out once on 28 Dec without anyone knowing)
//   3. one transaction moves the new tables into public and the old ones out, then drops them
// Any failure leaves the live timetable as it was and exits non-zero (GitHub emails the owner).
// HEALTHCHECK_URL, if set, is pinged on success and at /fail on failure (healthchecks.io).
//
// stop_times is loaded sorted by stop then time, so a stop's departures sit together on disk
// (departures read ~200 pages instead of ~7,000), and without the old (trip_id, stop_sequence)
// index: the trip_id index serves those lookups and the other one was 175 MB.

require('dotenv').config();
const { Client } = require('pg');
const fetch = require('node-fetch');
const yauzl = require('yauzl-promise');
const { parse } = require('csv-parse');

const GTFS_URL = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';
const DRY_RUN = process.argv.includes('--dry-run');
const NEW = 'gtfs_new';
const OLD = 'gtfs_old';
// Postgres allows 65,535 bind parameters per statement
const MAX_PARAMS = 60000;
const MIN_DAYS_AHEAD = 14;
const MIN_COUNTS = { routes: 300, trips: 50000, stops: 8000, stop_times: 1000000, route_shapes: 500, calendar: 20 };

// The live tables a swap replaces (PostGIS's spatial_ref_sys is never touched)
const TABLES = ['agency', 'routes', 'calendar', 'calendar_dates', 'trips', 'stops', 'stop_times',
    'route_shapes', 'suburb_routes', 'route_directions_precomputed'];

const createTablesQuery = `
  CREATE TABLE agency (
    agency_name VARCHAR(255), agency_url TEXT, agency_timezone VARCHAR(50),
    agency_lang VARCHAR(10), agency_phone VARCHAR(50)
  );
  CREATE TABLE routes (
    route_id VARCHAR(255) PRIMARY KEY, route_short_name VARCHAR(50), route_long_name TEXT,
    route_desc TEXT, route_type INT, route_url TEXT, route_color VARCHAR(6), route_text_color VARCHAR(6)
  );
  CREATE TABLE calendar (
    service_id VARCHAR(255) PRIMARY KEY,
    monday INT, tuesday INT, wednesday INT, thursday INT, friday INT, saturday INT, sunday INT,
    start_date VARCHAR(8), end_date VARCHAR(8)
  );
  CREATE TABLE calendar_dates (service_id VARCHAR(255), date VARCHAR(8), exception_type INT);
  CREATE TABLE trips (
    route_id VARCHAR(255), service_id VARCHAR(255), trip_id VARCHAR(255) PRIMARY KEY,
    trip_headsign VARCHAR(255), direction_id INT, block_id VARCHAR(255), shape_id VARCHAR(255)
  );
  CREATE TABLE stops (
    stop_id VARCHAR(255) PRIMARY KEY, stop_code VARCHAR(50), stop_name VARCHAR(255), stop_desc TEXT,
    stop_lat DOUBLE PRECISION, stop_lon DOUBLE PRECISION, zone_id VARCHAR(255), stop_url TEXT,
    location_type INT, parent_station VARCHAR(255), platform_code VARCHAR(50), suburb TEXT,
    location GEOGRAPHY(Point, 4326),
    servicing_routes TEXT,
    route_directions JSONB,
    route_types INTEGER[]
  );
  CREATE TABLE stop_times (
    trip_id VARCHAR(255), arrival_time VARCHAR(10), departure_time VARCHAR(10), stop_id VARCHAR(255),
    stop_sequence INT, pickup_type INT, drop_off_type INT
  );
  CREATE TABLE shapes (
    shape_id VARCHAR(255), shape_pt_lat DOUBLE PRECISION, shape_pt_lon DOUBLE PRECISION, shape_pt_sequence INT
  );
  CREATE TABLE route_shapes (shape_id VARCHAR(255) PRIMARY KEY, shape GEOMETRY(LINESTRING, 4326));
  CREATE TABLE suburb_routes (suburb TEXT, route_id TEXT);
  CREATE TABLE route_directions_precomputed (
    route_id VARCHAR(255), direction_id INT, trip_headsign VARCHAR(255), shape_id VARCHAR(255)
  );
`;

/** Every row of a GTFS file, as objects keyed by header */
async function readCsv(entry) {
  const rows = [];
  const parser = (await entry.openReadStream()).pipe(parse({ columns: true, skip_empty_lines: true }));
  for await (const record of parser) rows.push(record);
  return rows;
}

async function insertRows(client, table, columns, rows) {
  const batchSize = Math.floor(MAX_PARAMS / columns.length);
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const placeholders = batch.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`).join(', ');
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
      batch.flatMap(row => columns.map(col => (row[col] === '' ? null : row[col]))));
  }
  console.log(`  ${table}: ${rows.length.toLocaleString()} rows`);
}

async function loadFile(client, zipEntries, file, table, columns, sort) {
  const entry = zipEntries.get(file);
  if (!entry) throw new Error(`${file} is missing from the GTFS zip`);
  const rows = await readCsv(entry);
  if (sort) rows.sort(sort);
  await insertRows(client, table, columns, rows);
}

/** "YYYYMMDD" for a date this many days from now, in Brisbane */
function brisbaneDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }).replace(/-/g, '');
}

async function check(client) {
  const problems = [];
  for (const [table, min] of Object.entries(MIN_COUNTS)) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${NEW}.${table}`);
    console.log(`  ${table}: ${rows[0].n.toLocaleString()}`);
    if (rows[0].n < min) problems.push(`${table} has ${rows[0].n} rows (expected at least ${min})`);
  }
  const { rows } = await client.query(`SELECT max(end_date) AS e FROM ${NEW}.calendar`);
  const needed = brisbaneDate(MIN_DAYS_AHEAD);
  console.log(`  calendar runs to ${rows[0].e} (needs ${needed} or later)`);
  if (!rows[0].e || rows[0].e < needed) problems.push(`calendar ends ${rows[0].e}, before ${needed}`);
  if (problems.length) throw new Error(`New timetable failed its checks:\n - ${problems.join('\n - ')}`);
}

async function swap(client) {
  await client.query('BEGIN');
  await client.query(`DROP SCHEMA IF EXISTS ${OLD} CASCADE`);
  await client.query(`CREATE SCHEMA ${OLD}`);
  for (const t of TABLES) await client.query(`ALTER TABLE IF EXISTS public.${t} SET SCHEMA ${OLD}`);
  for (const t of TABLES) await client.query(`ALTER TABLE ${NEW}.${t} SET SCHEMA public`);
  await client.query('COMMIT');
  console.log('✅ Swapped: the new timetable is live.');
  await client.query(`DROP SCHEMA ${OLD} CASCADE`);
  await client.query(`DROP SCHEMA ${NEW} CASCADE`);
}

async function ping(suffix = '') {
  if (!process.env.HEALTHCHECK_URL) return;
  await fetch(process.env.HEALTHCHECK_URL + suffix, { timeout: 10000 }).catch(() => {});
}

async function main() {
  const started = Date.now();
  const client = new Client({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
  await client.connect();
  try {
    console.log(`Downloading ${GTFS_URL}…`);
    const response = await fetch(GTFS_URL, { timeout: 120000 });
    if (!response.ok) throw new Error(`GTFS download failed: HTTP ${response.status}`);
    const buffer = await response.buffer();
    console.log(`✅ Downloaded ${Math.round(buffer.length / 1024 / 1024)} MB.`);
    const zip = await yauzl.fromBuffer(buffer);
    const zipEntries = new Map();
    for await (const entry of zip) zipEntries.set(entry.filename, entry);

    console.log(`Building the new timetable in schema ${NEW}…`);
    await client.query(`DROP SCHEMA IF EXISTS ${NEW} CASCADE`);
    await client.query(`CREATE SCHEMA ${NEW}`);
    // New tables land in gtfs_new; PostGIS and pg_trgm (types, functions) live in public
    await client.query(`SET search_path TO ${NEW}, public`);
    await client.query(createTablesQuery);

    await loadFile(client, zipEntries, 'agency.txt', 'agency', ['agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone']);
    await loadFile(client, zipEntries, 'routes.txt', 'routes', ['route_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_url', 'route_color', 'route_text_color']);
    await loadFile(client, zipEntries, 'calendar.txt', 'calendar', ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']);
    await loadFile(client, zipEntries, 'calendar_dates.txt', 'calendar_dates', ['service_id', 'date', 'exception_type']);
    await loadFile(client, zipEntries, 'trips.txt', 'trips', ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'block_id', 'shape_id']);
    await loadFile(client, zipEntries, 'stops.txt', 'stops', ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'zone_id', 'stop_url', 'location_type', 'parent_station', 'platform_code', 'suburb']);
    // Sorted by stop then time: each stop's departures end up together on disk
    await loadFile(client, zipEntries, 'stop_times.txt', 'stop_times', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
      (a, b) => (a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : a.departure_time < b.departure_time ? -1 : a.departure_time > b.departure_time ? 1 : 0));
    await loadFile(client, zipEntries, 'shapes.txt', 'shapes', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']);

    console.log('Post-processing…');
    await client.query(`UPDATE stops SET location = ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326) WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL`);
    await client.query(`
      INSERT INTO route_shapes (shape_id, shape)
      SELECT shape_id, ST_MakeLine(ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326) ORDER BY shape_pt_sequence)
      FROM shapes GROUP BY shape_id`);
    await client.query('DROP TABLE shapes');
    await client.query(`
      WITH stop_route_info AS (
        SELECT st.stop_id, r.route_short_name, r.route_type,
               JSONB_AGG(DISTINCT CASE WHEN t.direction_id = 0 THEN 'Inbound' WHEN t.direction_id = 1 THEN 'Outbound' ELSE NULL END) AS directions
        FROM stop_times st JOIN trips t ON st.trip_id = t.trip_id JOIN routes r ON t.route_id = r.route_id
        GROUP BY st.stop_id, r.route_short_name, r.route_type
      ),
      stop_summary AS (
        SELECT stop_id, STRING_AGG(route_short_name, ', ') AS routes_text,
               JSONB_OBJECT_AGG(route_short_name, directions) AS route_directions_json,
               ARRAY_AGG(DISTINCT route_type) AS route_types_array
        FROM stop_route_info GROUP BY stop_id
      )
      UPDATE stops SET servicing_routes = ss.routes_text, route_directions = ss.route_directions_json, route_types = ss.route_types_array
      FROM stop_summary ss WHERE stops.stop_id = ss.stop_id`);
    await client.query(`
      INSERT INTO suburb_routes (suburb, route_id)
      SELECT DISTINCT s.suburb, t.route_id
      FROM stops s JOIN stop_times st ON s.stop_id = st.stop_id JOIN trips t ON st.trip_id = t.trip_id
      WHERE s.suburb IS NOT NULL AND s.suburb != ''`);
    await client.query(`
      INSERT INTO route_directions_precomputed (route_id, direction_id, trip_headsign, shape_id)
      SELECT DISTINCT ON (tr.route_id, tr.direction_id) tr.route_id, tr.direction_id, tr.trip_headsign, tr.shape_id
      FROM trips tr JOIN (SELECT trip_id, COUNT(*) AS stop_count FROM stop_times GROUP BY trip_id) sc ON tr.trip_id = sc.trip_id
      ORDER BY tr.route_id, tr.direction_id, sc.stop_count DESC`);

    console.log('Indexes…');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public');
    for (const sql of [
      'CREATE INDEX stops_location_idx ON stops USING GIST (location)',
      'CREATE INDEX stops_suburb_idx ON stops (suburb)',
      'CREATE INDEX stops_name_trgm_idx ON stops USING GIN (stop_name gin_trgm_ops)',
      'CREATE INDEX stops_parent_station_idx ON stops (parent_station)',
      'CREATE INDEX stops_stop_code_idx ON stops (stop_code)',
      'CREATE INDEX stop_times_trip_id_idx ON stop_times (trip_id)',
      'CREATE INDEX stop_times_stop_id_idx ON stop_times (stop_id)',
      'CREATE INDEX trips_route_id_idx ON trips (route_id)',
      'CREATE INDEX trips_service_id_idx ON trips (service_id)',
      'CREATE INDEX suburb_routes_suburb_idx ON suburb_routes (suburb)',
      'CREATE INDEX calendar_dates_service_id_idx ON calendar_dates (service_id)',
      'CREATE INDEX route_directions_route_id_idx ON route_directions_precomputed (route_id)'
    ]) await client.query(sql);
    for (const t of TABLES) await client.query(`ANALYZE ${t}`);

    console.log('Checking…');
    await check(client);

    if (DRY_RUN) {
      console.log(`Dry run: checks passed; dropping ${NEW}, live tables untouched.`);
      await client.query(`DROP SCHEMA ${NEW} CASCADE`);
    } else {
      await swap(client);
    }
    console.log(`🎉 Done in ${Math.round((Date.now() - started) / 60000)} min.`);
    await ping();
  } catch (error) {
    console.error('❌ Timetable import failed; the live timetable is unchanged.\n', error);
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${NEW} CASCADE`).catch(() => {});
    await ping('/fail');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
