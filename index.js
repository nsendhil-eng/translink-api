// index.js (Upgraded with advanced JOIN query)

require('dotenv').config();
const { createPool } = require('@vercel/postgres');
const fetch = require('node-fetch');
const cors = require('cors');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());

const pool = createPool({
    connectionString: process.env.POSTGRES_URL,
});

const BUS_ROUTE_INFO = { /* ... (remains the same) ... */ };
const fetchOptions = { headers: { /* ... (remains the same) ... */ } };

// --- UPGRADED GEOSPATIAL API ENDPOINT ---
app.get('/api/stops-near-me', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) { return res.status(400).json({ error: 'Latitude and longitude query parameters are required.' }); }

  try {
    const radiusInMeters = 500;
    
    // This query now fetches the pre-calculated data and parent station info.
    const { rows } = await pool.query(`
      SELECT 
        s.stop_id AS id,
        s.stop_name AS name,
        s.stop_code,
        s.parent_station,
        parent_stop.stop_name AS parent_station_name,
        s.servicing_routes,
        s.route_directions
      FROM stops AS s
      LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
      WHERE ST_DWithin(
        s.location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
      ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
      LIMIT 20; -- Increased limit to fetch all platforms of a station
    `, [lon, lat, radiusInMeters]);

    res.json(rows);
  } catch (error) {
    console.error('Geospatial query failed:', error);
    res.status(500).json({ error: 'Failed to fetch nearby stops.' });
  }
});


// --- The /api/departures endpoint remains the same ---
app.get('/api/departures', async (req, res) => {
  // ... (all the logic from the previous version remains here)
  let urlsToFetch = [];
  const stopIds = req.query.stops;
  if (stopIds) {
    urlsToFetch = stopIds.split(',').map(id => `https://jp.translink.com.au/api/stop/timetable/${id.trim()}`);
  } else {
    urlsToFetch = [ 'https://jp.translink.com.au/api/stop/timetable/001951', 'https://jp.translink.com.au/api/stop/timetable/600284', 'https://jp.translink.com.au/api/stop/timetable/600286' ];
  }
  if (urlsToFetch.length === 0) { return res.json([]); }
  try {
    const requests = urlsToFetch.map(url => fetch(url, fetchOptions));
    const responses = await Promise.all(requests);
    const successfulResponses = responses.filter(r => r.ok);
    const data = await Promise.all(successfulResponses.map(r => r.json()));
    let allDepartures = [];
    data.forEach(stopData => {
      if (stopData.departures) {
        stopData.departures.forEach(dep => {
          if (dep.canBoardDebark === 'Both') {
            const vehicleType = stopData.name.toLowerCase().includes('station') ? 'Train' : 'Bus';
            const routeIdParts = dep.routeId.split(':');
            const routeNumber = routeIdParts[routeIdParts.length - 1];
            allDepartures.push({
              stopName: stopData.name, vehicleType: vehicleType, routeNumber: routeNumber, headsign: dep.headsign,
              scheduledDepartureUtc: dep.scheduledDepartureUtc,
              expectedDepartureUtc: dep.realtime ? dep.realtime.expectedDepartureUtc : null,
              departureDescription: dep.departureDescription,
              destinationInfo: vehicleType === 'Bus' ? (BUS_ROUTE_INFO[routeNumber] || null) : null
            });
          }
        });
      }
    });
    if (allDepartures.length === 0) return res.json([]);
    const referenceApiDate = new Date(allDepartures[0].scheduledDepartureUtc);
    const currentServerTime = new Date();
    const now = new Date(Date.UTC(
        referenceApiDate.getUTCFullYear(), referenceApiDate.getUTCMonth(), referenceApiDate.getUTCDate(),
        currentServerTime.getUTCHours(), currentServerTime.getUTCMinutes(), currentServerTime.getUTCSeconds()
    ));
    allDepartures.forEach(dep => {
        const departureTime = new Date(dep.expectedDepartureUtc || dep.scheduledDepartureUtc);
        dep.secondsUntilDeparture = Math.round((departureTime - now) / 1000);
    });
    allDepartures.sort((a, b) => a.secondsUntilDeparture - b.secondsUntilDeparture);
    res.json(allDepartures);
  } catch (error) {
    console.error('An error occurred in /api/departures:', error);
    res.status(500).json({ message: 'The server failed to process the request.', error_details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});