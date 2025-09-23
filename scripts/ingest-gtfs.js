// scripts/ingest-gtfs.js (Updated with correct GTFS URL)

require('dotenv').config();
const { createClient } = require('@vercel/postgres');
const fetch = require('node-fetch');
const yauzl = require('yauzl-promise');
const { parse } = require('csv-parse');

// --- THIS IS THE CORRECTED URL ---
const GTFS_URL = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';
const BATCH_SIZE = 500;

const createTablesQuery = `
  CREATE TABLE IF NOT EXISTS agency (
    agency_name VARCHAR(255), agency_url TEXT, agency_timezone VARCHAR(50),
    agency_lang VARCHAR(10), agency_phone VARCHAR(50)
  );
  CREATE TABLE IF NOT EXISTS routes (
    route_id VARCHAR(255) PRIMARY KEY, route_short_name VARCHAR(50), route_long_name TEXT,
    route_desc TEXT, route_type INT, route_url TEXT, route_color VARCHAR(6), route_text_color VARCHAR(6)
  );
  CREATE TABLE IF NOT EXISTS calendar (
    service_id VARCHAR(255) PRIMARY KEY, monday INT, tuesday INT, wednesday INT, thursday INT,
    friday INT, saturday INT, sunday INT, start_date VARCHAR(8), end_date VARCHAR(8)
  );
  CREATE TABLE IF NOT EXISTS calendar_dates (
    service_id VARCHAR(255), date VARCHAR(8), exception_type INT
  );
  CREATE TABLE IF NOT EXISTS trips (
    route_id VARCHAR(255), service_id VARCHAR(255), trip_id VARCHAR(255) PRIMARY KEY,
    trip_headsign VARCHAR(255), direction_id INT, block_id VARCHAR(255), shape_id VARCHAR(255)
  );
  CREATE TABLE IF NOT EXISTS stops (
    stop_id VARCHAR(255) PRIMARY KEY, stop_code VARCHAR(50), stop_name VARCHAR(255), stop_desc TEXT,
    stop_lat DOUBLE PRECISION, stop_lon DOUBLE PRECISION, zone_id VARCHAR(255), stop_url TEXT,
    location_type INT, parent_station VARCHAR(255), platform_code VARCHAR(50),
    location GEOGRAPHY(Point, 4326),
    -- NEW COLUMNS FOR PRE-CALCULATED DATA --
    servicing_routes TEXT,
    route_directions JSONB
  );
  CREATE TABLE IF NOT EXISTS stop_times (
    trip_id VARCHAR(255), arrival_time VARCHAR(10), departure_time VARCHAR(10),
    stop_id VARCHAR(255), stop_sequence INT, pickup_type INT, drop_off_type INT
  );
`;

async function processGtfsFile(client, entry, tableName, columns) {
  console.log(`Processing ${entry.filename}...`);
  if (!entry) {
    console.warn(`⚠️ ${entry.filename} not found. Skipping.`);
    return 0;
  }
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
  const client = createClient({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
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
    for await (const entry of zip) { zipEntries.set(entry.filename, entry); }
    
    // ... (Processing for all files remains the same) ...
    
    console.log('\n--- Post-processing data ---');
    console.log('Populating geography column using PostGIS...');
    await client.query(`UPDATE stops SET location = ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326) WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL;`);
    console.log('✅ Geography column populated.');

    // --- NEW: PRE-CALCULATION OF ROUTES AND DIRECTIONS ---
    console.log('Pre-calculating servicing routes and directions for all stops... (This may take several minutes)');
    await client.query(`
        WITH stop_route_directions AS (
            SELECT
                st.stop_id,
                r.route_short_name,
                -- Aggregate the distinct direction names (Inbound/Outbound) into a JSON array for each route at each stop
                JSONB_AGG(DISTINCT CASE WHEN t.direction_id = 0 THEN 'Outbound' WHEN t.direction_id = 1 THEN 'Inbound' ELSE 'Unknown' END) AS directions
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
            GROUP BY st.stop_id, r.route_short_name
        ),
        stop_summary AS (
            SELECT
                stop_id,
                -- Create a comma-separated list of all routes for the stop
                STRING_AGG(route_short_name, ', ') AS routes_text,
                -- Aggregate the route-specific direction arrays into a single JSON object for the stop
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
    // --- END OF NEW STEP ---

    console.log('Creating indexes for faster queries...');
    await client.query('CREATE INDEX IF NOT EXISTS stops_location_idx ON stops USING GIST (location);');
    // ... (other index creations remain the same) ...
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