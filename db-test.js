// db-test.js (Corrected)
require('dotenv').config(); // Corrected from '.env' to 'dotenv'
const { sql } = require('@vercel/postgres');

async function testConnection() {
  try {
    const { rows } = await sql`SELECT NOW();`;
    console.log('✅ Connection successful! Database time is:', rows[0].now);
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
}

testConnection();