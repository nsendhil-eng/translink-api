// index.js

require('dotenv').config();
const { createPool } = require('@vercel/postgres');
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());

const pool = createPool({
    connectionString: process.env.POSTGRES_URL,
});

const BUS_ROUTE_INFO = { '411': 'Adelaide Street Stop 22 (13 mins travel)', '460': 'Roma Street busway station', '412': 'Ann Street Stop 7 (King George Square)', '454': 'Roma Street busway station', '425': 'Adelaide Street Stop 22 (13 mins travel)', '417': 'Adelaide Street Stop 22 (14 mins travel)', '435': 'Adelaide Street Stop 22 (13 mins travel)', '444': 'King George Square station (10 mins travel)', '415': 'Adelaide Street Stop 22 (13 mins travel)', '445': 'Adelaide Street Stop 22 (13 mins travel)', '453': 'Roma Street busway station',};
const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' } };

// --- TEXT SEARCH API ENDPOINT ---
app.get('/api/search-stops', async (req, res) => {
  const { q } = req.query;

  if (!q || q.length < 3) {
    return res.json([]);
  }

  try {
    const searchQuery = `%${q}%`;
    
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
      WHERE 
        s.stop_name ILIKE $1 OR COALESCE(s.stop_desc, '') ILIKE $1
      LIMIT 20;
    `, [searchQuery]);

    res.json(rows);
  } catch (error) {
    console.error('Text search query failed:', error);
    res.status(500).json({ error: 'Failed to search for stops.' });
  }
});

// --- GEOSPATIAL API ENDPOINT ---
app.get('/api/stops-near-me', async (req, res) => {
  const { lat, lon, radius, types } = req.query;
  if (!lat || !lon) { return res.status(400).json({ error: 'Latitude and longitude are required.' }); }

  try {
    const radiusInMeters = parseInt(radius, 10) || 500;
    const typeFilter = types ? types.split(',').map(Number) : null;

    let query = `
      SELECT 
        s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station,
        parent_stop.stop_name AS parent_station_name, s.servicing_routes, s.route_directions
      FROM stops AS s
      LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
      WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
    `;

    const queryParams = [lon, lat, radiusInMeters];
    
    // If a type filter is provided, add it to the query
    if (typeFilter && typeFilter.length > 0) {
      query += ` AND s.route_types && $4`; // '&&' is the array "overlaps" operator
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

// --- REAL-TIME DEPARTURES API ENDPOINT ---
app.get('/api/departures', async (req, res) => {
  const stopCodes = req.query.stops;

  console.log(`Fetching departures for stops: ${stopCodes}`);
  
  if (!stopCodes) {
    // Default stops if none are provided
    const defaultStopCodes = ['001951', '600284', '600286'];
    const urlsToFetch = defaultStopCodes.map(code => `https://jp.translink.com.au/api/stop/timetable/${code.trim()}`);
    return fetchDepartures(urlsToFetch, res);
  }

  const urlsToFetch = stopCodes.split(',').map(code => `https://jp.translink.com.au/api/stop/timetable/${code.trim()}`);
  return fetchDepartures(urlsToFetch, res);
});

async function fetchDepartures(urlsToFetch, res) {
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
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});