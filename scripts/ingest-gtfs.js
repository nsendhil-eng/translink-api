// scripts/ingest-gtfs.js (Corrected with DROP TABLE)

require('dotenv').config();
const { createClient } = require('@vercel/postgres');
const fetch = require('node-fetch');
const yauzl = require('yauzl-promise');
const { parse } = require('csv-parse');

const GTFS_URL = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';
const BATCH_SIZE = 500;

const createTablesQuery = `
  -- NEW: Drop existing tables to ensure a fresh start
  DROP TABLE IF EXISTS agency, routes, calendar, calendar_dates, trips, stops, stop_times;

  CREATE TABLE IF NOT EXISTS agency (
    agency_name VARCHAR(255),
    agency_url TEXT,
    agency_timezone VARCHAR(50),
    agency_lang VARCHAR(10),
    agency_phone VARCHAR(50)
  );
  CREATE TABLE IF NOT EXISTS routes (
    route_id VARCHAR(255) PRIMARY KEY,
    route_short_name VARCHAR(50),
    route_long_name TEXT,
    route_desc TEXT,
    route_type INT,
    route_url TEXT,
    route_color VARCHAR(6),
    route_text_color VARCHAR(6)
  );
  CREATE TABLE IF NOT EXISTS calendar (
    service_id VARCHAR(255) PRIMARY KEY,
    monday INT, tuesday INT, wednesday INT, thursday INT,
    friday INT, saturday INT, sunday INT,
    start_date VARCHAR(8), end_date VARCHAR(8)
  );
  CREATE TABLE IF NOT EXISTS calendar_dates (
    service_id VARCHAR(255),
    date VARCHAR(8),
    exception_type INT
  );
  CREATE TABLE IF NOT EXISTS trips (
    route_id VARCHAR(255),
    service_id VARCHAR(255),
    trip_id VARCHAR(255) PRIMARY KEY,
    trip_headsign VARCHAR(255),
    direction_id INT,
    block_id VARCHAR(255),
    shape_id VARCHAR(255)
  );
  CREATE TABLE IF NOT EXISTS stops (
    stop_id VARCHAR(255) PRIMARY KEY, stop_code VARCHAR(50), stop_name VARCHAR(255), stop_desc TEXT,
    stop_lat DOUBLE PRECISION, stop_lon DOUBLE PRECISION, zone_id VARCHAR(255), stop_url TEXT,
    location_type INT, parent_station VARCHAR(255), platform_code VARCHAR(50),
    location GEOGRAPHY(Point, 4326),
    servicing_routes TEXT,
    route_directions JSONB
  );
  CREATE TABLE IF NOT EXISTS stop_times (
    trip_id VARCHAR(255),
    arrival_time VARCHAR(10),
    departure_time VARCHAR(10),
    stop_id VARCHAR(255),
    stop_sequence INT,
    pickup_type INT,
    drop_off_type INT
  );
`;

async function processGtfsFile(client, entry, tableName, columns) {
  console.log(`Processing ${entry.filename}...`);
  if (!entry) {
    console.warn(`⚠️ ${entry.filename} not found. Skipping.`);
    return 0;
  }
  // TRUNCATE is still good practice here in case DROP fails for any reason
  await client.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY;`);
  const readStream = await entry.openReadStream();
  const parser = readStream.pipe(parse({ columns: true, skip_empty_lines: true }));
  let batch = [];
  let totalCount = 0;
  for await (const record of parser) {
    batch.push(record);
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(client, tableName, columns, batch);
      totalCount += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(client, tableName, columns, batch);
    totalCount += batch.length;
  }
  console.log(`✅ Inserted ${totalCount} records into ${tableName}.`);
  return totalCount;
}

async function insertBatch(client, tableName, columns, batch) {
  const values = batch.map(record => columns.map(col => record[col]));
  const valuePlaceholders = values.map((_, index) => `(${columns.map((_, i) => `$${index * columns.length + i + 1}`).join(', ')})`).join(', ');
  const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valuePlaceholders}`;
  await client.query(query, values.flat());
}

async function main() {
  console.log('Connecting to database...');
  const client = createClient({
    connectionString: process.env.POSTGRES_URL_NON_POOLING,
  });
  await client.connect();
  console.log('✅ Database connected.');

  try {
    console.log('Setting up database tables...');
    await client.query(createTablesQuery);
    console.log('✅ Tables are ready.');

    console.log(`Downloading GTFS data from ${GTFS_URL}...`);
    const response = await fetch(GTFS_URL);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    const buffer = await response.buffer();
    console.log(`✅ Downloaded ${Math.round(buffer.length / 1024 / 1024)}MB file.`);

    const zip = await yauzl.fromBuffer(buffer);
    const zipEntries = new Map();
    for await (const entry of zip) {
      zipEntries.set(entry.filename, entry);
    }
    
    await processGtfsFile(client, zipEntries.get('agency.txt'), 'agency', ['agency_name','agency_url','agency_timezone','agency_lang','agency_phone']);
    await processGtfsFile(client, zipEntries.get('routes.txt'), 'routes', ['route_id','route_short_name','route_long_name','route_desc','route_type','route_url','route_color','route_text_color']);
    await processGtfsFile(client, zipEntries.get('calendar.txt'), 'calendar', ['service_id','monday','tuesday','wednesday','thursday','friday','saturday','sunday','start_date','end_date']);
    await processGtfsFile(client, zipEntries.get('calendar_dates.txt'), 'calendar_dates', ['service_id','date','exception_type']);
    await processGtfsFile(client, zipEntries.get('trips.txt'), 'trips', ['route_id','service_id','trip_id','trip_headsign','direction_id','block_id','shape_id']);
    await processGtfsFile(client, zipEntries.get('stops.txt'), 'stops', ['stop_id','stop_code','stop_name','stop_desc','stop_lat','stop_lon','zone_id','stop_url','location_type','parent_station','platform_code']);
    await processGtfsFile(client, zipEntries.get('stop_times.txt'), 'stop_times', ['trip_id','arrival_time','departure_time','stop_id','stop_sequence','pickup_type','drop_off_type']);

    console.log('\n--- Post-processing data ---');
    console.log('Populating geography column using PostGIS...');
    await client.query(`UPDATE stops SET location = ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326) WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL;`);
    console.log('✅ Geography column populated.');

    console.log('Pre-calculating servicing routes and directions for all stops... (This may take several minutes)');
    await client.query(`
        WITH stop_route_directions AS (
            SELECT
                st.stop_id,
                r.route_short_name,
                JSONB_AGG(DISTINCT CASE WHEN t.direction_id = 0 THEN 'Outbound' WHEN t.direction_id = 1 THEN 'Inbound' ELSE NULL END) AS directions
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
            GROUP BY st.stop_id, r.route_short_name
        ),
        stop_summary AS (
            SELECT
                stop_id,
                STRING_AGG(route_short_name, ', ') AS routes_text,
                JSONB_OBJECT_AGG(route_short_name, directions) AS route_directions_json
            FROM stop_route_directions
            GROUP BY stop_id
        )
        UPDATE stops
        SET
            servicing_routes = ss.routes_text,
            route_directions = ss.route_directions_json
        FROM stop_summary ss
        WHERE stops.stop_id = ss.stop_id;
    `);
    console.log('✅ Servicing routes and directions pre-calculated.');

    console.log('Creating indexes for faster queries...');
    await client.query('CREATE INDEX IF NOT EXISTS stops_location_idx ON stops USING GIST (location);');
    await client.query('CREATE INDEX IF NOT EXISTS stop_times_trip_id_idx ON stop_times (trip_id);');
    await client.query('CREATE INDEX IF NOT EXISTS stop_times_stop_id_idx ON stop_times (stop_id);');
    await client.query('CREATE INDEX IF NOT EXISTS trips_route_id_idx ON trips (route_id);');
    await client.query('CREATE INDEX IF NOT EXISTS trips_service_id_idx ON trips (service_id);');
    await client.query('CREATE INDEX IF NOT EXISTS calendar_dates_service_id_idx ON calendar_dates (service_id);');
    console.log('✅ Indexes are ready.');

    console.log('\n🎉 GTFS data ingestion complete!');

  } catch (error) {
    console.error('❌ An error occurred during GTFS ingestion:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

main();