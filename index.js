// index.js (Cleaned up and corrected)

require('dotenv').config();
const { createPool } = require('@vercel/postgres');
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const protobuf = require('protobufjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());

const pool = createPool({
    connectionString: process.env.POSTGRES_URL,
});

const REALTIME_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';
const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

// Load the GTFS-realtime schema once when the server starts
let gtfsRealtime;
protobuf.load(path.join(__dirname, 'gtfs-realtime.proto')).then((root) => {
    gtfsRealtime = root.lookupType("transit_realtime.FeedMessage");
    console.log('✅ GTFS-realtime schema loaded.');
}).catch(err => console.error('❌ Failed to load GTFS-realtime schema:', err));


// --- SEARCH ENDPOINTS ---
app.get('/api/search-stops', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 3) { return res.json([]); }
  try {
    const searchQuery = `%${q}%`;
    // FIX: Simplified query to only select columns that exist in the stable schema
    const { rows } = await pool.query(`
      SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
             parent_stop.stop_name AS parent_station_name,
             ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
      FROM stops AS s
      LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
      WHERE s.stop_name ILIKE $1 OR COALESCE(s.stop_desc, '') ILIKE $1
      LIMIT 20;
    `, [searchQuery]);
    res.json(rows);
  } catch (error) {
    console.error('Text search query failed:', error);
    res.status(500).json({ error: 'Failed to search for stops.' });
  }
});

app.get('/api/stops-near-me', async (req, res) => {
  const { lat, lon, radius, types } = req.query;
  if (!lat || !lon) { return res.status(400).json({ error: 'Latitude and longitude are required.' }); }
  try {
    const radiusInMeters = parseInt(radius, 10) || 500;
    const typeFilter = types ? types.split(',').map(Number) : null;
    let query = `
      SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
             parent_stop.stop_name AS parent_station_name, ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance,
             ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
      FROM stops AS s
      LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
      WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
    `;
    const queryParams = [lon, lat, radiusInMeters];
    if (typeFilter && typeFilter.length > 0) {
      query += ` AND s.route_types && $4`;
      queryParams.push(typeFilter);
    }
    query += ` ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 25;`;
    const { rows } = await pool.query(query, queryParams);
    res.json(rows);
  } catch (error) {
    console.error('Geospatial query failed:', error);
    res.status(500).json({ error: 'Failed to fetch nearby stops.' });
  }
});

// --- MAIN DEPARTURES ENDPOINT ---
app.get('/api/departures', async (req, res) => {
    const stopCodes = (req.query.stops || '001951,600284,600286').split(',');
    
    try {
        const now = new Date();
        const timeZone = 'Australia/Brisbane';
        const parts = new Intl.DateTimeFormat('en-AU', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(now);
        const findPart = (type) => parts.find(p => p.type === type)?.value || '';
        const dayOfWeek = findPart('weekday').toLowerCase();
        const dateString = `${findPart('year')}${findPart('month')}${findPart('day')}`;

        const staticQuery = `
            SELECT
                st.trip_id, s.stop_id, s.stop_name, st.stop_sequence, st.departure_time,s.platform_code,
                t.trip_headsign, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
                r.route_type,
                CASE WHEN r.route_type = 3 THEN 'Bus' WHEN r.route_type = 4 THEN 'Ferry' ELSE 'Train' END AS vehicle_type
            FROM stop_times AS st
            JOIN trips AS t ON st.trip_id = t.trip_id
            JOIN routes AS r ON t.route_id = r.route_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE s.stop_code = ANY($1::text[])
            AND t.service_id IN (
                (SELECT service_id FROM calendar WHERE start_date <= $2 AND end_date >= $2 AND ${dayOfWeek} = 1)
                EXCEPT (SELECT service_id FROM calendar_dates WHERE date = $2 AND exception_type = 2)
                UNION (SELECT service_id FROM calendar_dates WHERE date = $2 AND exception_type = 1)
            );
        `;
        const staticResult = await pool.query(staticQuery, [stopCodes, dateString]);
        const scheduledDepartures = staticResult.rows;

        if (scheduledDepartures.length === 0) {
            return res.json([]);
        }

        // --- CORRECT: Fetch and decode the GTFS-realtime protobuf feed ---
        const liveResponse = await fetch(REALTIME_URL, fetchOptions);
        if (!liveResponse.ok) {
            throw new Error(`Failed to fetch live data: ${liveResponse.statusText}`);
        }
        const buffer = await liveResponse.arrayBuffer();
        const feed = gtfsRealtime.decode(Buffer.from(buffer));

        const liveDataMap = new Map();
        feed.entity.forEach(entity => {
            if (entity.tripUpdate) {
                liveDataMap.set(entity.tripUpdate.trip.tripId, entity.tripUpdate.stopTimeUpdate);
            }
        });
        
        const synchronizedNow = new Date();
        const enrichedDepartures = scheduledDepartures.map(s => {
            // --- ROBUST TIME CALCULATION LOGIC ---
            const [h, m, sec] = s.departure_time.split(':').map(Number); // e.g., [25, 15, 35]

            // 1. Create a date object for the service day in Brisbane time.
            // The dateString is 'YYYYMMDD'.
            const year = parseInt(dateString.substring(0, 4), 10);
            const month = parseInt(dateString.substring(4, 6), 10) - 1; // Month is 0-indexed
            const day = parseInt(dateString.substring(6, 8), 10);

            // 2. Create a UTC date and then set the hours, minutes, seconds from GTFS.
            // This correctly handles hours > 23, which roll over to the next day.
            const scheduledUtc = new Date(Date.UTC(year, month, day));
            scheduledUtc.setUTCHours(h - 10, m, sec); // Set time and adjust for Brisbane (UTC+10)
            // --- END OF TIME LOGIC ---

            const stopTimeUpdates = liveDataMap.get(s.trip_id);
            let expectedUtc = scheduledUtc.toISOString();

            if (stopTimeUpdates) {
                const stopUpdate = stopTimeUpdates.find(stu => stu.stopSequence === s.stop_sequence);
                if (stopUpdate && stopUpdate.departure && stopUpdate.departure.time) {
                    expectedUtc = new Date(stopUpdate.departure.time.low * 1000).toISOString();
                }
            }
            const secondsUntil = Math.round((new Date(expectedUtc) - synchronizedNow) / 1000);
            
            let vehicleType = 'Train';
            if (s.route_type === 3) vehicleType = 'Bus';
            if (s.route_type === 4) vehicleType = 'Ferry';

            return {
                trip_id: s.trip_id,
                stop_sequence: s.stop_sequence,
                stopName: s.stop_name,
                vehicleType: vehicleType,
                routeNumber: s.route_short_name,
                headsign: s.trip_headsign,
                scheduledDepartureUtc: scheduledUtc.toISOString(),
                expectedDepartureUtc: (expectedUtc !== scheduledUtc.toISOString()) ? expectedUtc : null,
                secondsUntilDeparture: secondsUntil,
                routeLongName: s.route_long_name,
                routeColor: s.route_color,
                routeTextColor: s.route_text_color,
                platformCode:s.platform_code
            };
        });
        
        const upcomingDepartures = enrichedDepartures
            .filter(dep => dep.secondsUntilDeparture > -120)
            .sort((a, b) => a.secondsUntilDeparture - b.secondsUntilDeparture)
            .slice(0, 15);
        res.json(upcomingDepartures);
    } catch (error) {
        console.error('An error occurred in /api/departures:', error);
        res.status(500).json({ message: 'The server failed to process the request.', error_details: error.message });
    }
});

app.get('/api/trip-details', async (req, res) => {
    const { trip_id, stop_sequence } = req.query;
    if (!trip_id || !stop_sequence) { return res.status(400).json({ error: 'trip_id and stop_sequence are required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT s.stop_name, st.departure_time FROM stop_times st
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE st.trip_id = $1 AND st.stop_sequence > $2
            ORDER BY st.stop_sequence;
        `, [trip_id, stop_sequence]);
        res.json(rows);
    } catch (error) {
        console.error('Trip details query failed:', error);
        res.status(500).json({ error: 'Failed to fetch trip details.' });
    }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});