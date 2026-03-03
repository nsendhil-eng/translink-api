// One-time migration: add indexes to speed up stop name search.
// Run once: node scripts/add-search-indexes.js
//
// pg_trgm GIN index lets PostgreSQL use an index for ILIKE '%term%' queries
// instead of scanning every row. Typical speedup: 10-50x on a large stops table.

require('dotenv').config();
const { createPool } = require('@vercel/postgres');

const pool = createPool({ connectionString: process.env.POSTGRES_URL });

async function run() {
    const client = await pool.connect();
    try {
        console.log('Enabling pg_trgm extension...');
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

        console.log('Creating trigram index on stops.stop_name...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS stops_name_trgm_idx
            ON stops USING GIN (stop_name gin_trgm_ops);
        `);

        console.log('Creating index on stops.parent_station...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS stops_parent_station_idx
            ON stops (parent_station);
        `);

        console.log('Creating index on stops.stop_code...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS stops_stop_code_idx
            ON stops (stop_code);
        `);

        console.log('✅ All search indexes created.');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

run();
