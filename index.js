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


// --- UNIFIED SEARCH ENDPOINT ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 3) { return res.json({ stops: [], routes: [] }); }

    try {
        const searchQuery = `%${q}%`;

        // Step 1: Find initial matching stops and their parent stations.
        const initialStopsResult = await pool.query(`
            WITH initial_matches AS (
                SELECT stop_id, parent_station
                FROM stops
                WHERE stop_name ILIKE $1 OR COALESCE(stop_desc, '') ILIKE $1
                LIMIT 20
            )
            SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
                parent.stop_name AS parent_station_name,
                ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
            FROM stops s
            LEFT JOIN stops parent ON s.parent_station = parent.stop_id
            WHERE s.stop_id IN (SELECT stop_id FROM initial_matches)
               OR s.parent_station IN (SELECT parent_station FROM initial_matches WHERE parent_station IS NOT NULL AND parent_station != '')
               OR s.stop_id IN (SELECT parent_station FROM initial_matches WHERE parent_station IS NOT NULL AND parent_station != '');
        `, [searchQuery]);

        // De-duplicate stops, as the query might return the same stop multiple times
        const uniqueStops = Array.from(new Map(initialStopsResult.rows.map(stop => [stop.id, stop])).values());

        // The stopsPromise is now resolved.
        const stopsPromise = Promise.resolve({ rows: uniqueStops });

        // Search for routes with distinct headsigns
        const routesPromise = pool.query(`
            SELECT
                r.route_id,
                r.route_short_name,
                r.route_long_name,
                r.route_color,
                t.trip_headsign,
                t.shape_id
            FROM routes r
            JOIN (
                SELECT DISTINCT ON (route_id, trip_headsign) route_id, trip_headsign, shape_id
                FROM trips
            ) t ON r.route_id = t.route_id
            WHERE r.route_short_name ILIKE $1 OR r.route_long_name ILIKE $1
            ORDER BY r.route_short_name, t.trip_headsign
            LIMIT 10;
        `, [searchQuery]);
        
        // Search for routes by suburb
        const suburbRoutesPromise = pool.query(`
            SELECT
                r.route_id, r.route_short_name, r.route_long_name, r.route_color,
                t.trip_headsign, t.shape_id
            FROM routes r
            JOIN (SELECT DISTINCT ON (route_id, trip_headsign) route_id, trip_headsign, shape_id FROM trips) t
                ON r.route_id = t.route_id
            WHERE r.route_id IN (
                SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
            )
            LIMIT 10;
        `, [searchQuery]);

        const [stopsResult, routesResult, suburbRoutesResult] = await Promise.all([stopsPromise, routesPromise, suburbRoutesPromise]);

        // Merge and de-duplicate route results
        const allRoutes = [...routesResult.rows, ...suburbRoutesResult.rows];
        const uniqueRoutes = Array.from(new Map(allRoutes.map(route => [`${route.route_id}-${route.trip_headsign}`, route])).values());

        res.json({ stops: stopsResult.rows, routes: uniqueRoutes });

    } catch (error) {
        console.error('Unified search query failed:', error);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

// --- MOBILE SEARCH ENDPOINT (v2) ---
// Purpose-built for iOS/Android apps. Key differences from /api/search:
//   - Returns exactly one result per direction (DISTINCT ON direction_id), not per headsign.
//     This prevents train/ferry lines returning dozens of rows (one per terminus variant).
//   - Picks the headsign from the longest trip in each direction (true terminus, not a short-runner).
//   - Includes direction_id, route_type, and route_text_color in the response.
app.get('/api/v2/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) { return res.json({ stops: [], routes: [] }); }

    try {
        const searchQuery = `%${q}%`;

        // Stops — platform expansion + stop_code filter + optional distance ordering
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);
        const hasLocation = !isNaN(lat) && !isNaN(lon);

        const stopsQueryParams = hasLocation ? [searchQuery, lon, lat] : [searchQuery];
        const distanceSelect = hasLocation
            ? `ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography))::int AS distance_m`
            : `NULL::int AS distance_m`;
        const orderBy = hasLocation ? `ORDER BY distance_m ASC NULLS LAST` : `ORDER BY s.stop_name`;

        const stopsPromise = pool.query(`
            WITH initial_matches AS (
                SELECT stop_id, parent_station
                FROM stops
                WHERE stop_name ILIKE $1 OR COALESCE(stop_desc, '') ILIKE $1
                LIMIT 50
            ),
            expanded AS (
                SELECT stop_id FROM initial_matches
                WHERE parent_station IS NULL OR parent_station = ''
                UNION
                SELECT s.stop_id FROM stops s
                WHERE s.parent_station IN (
                    SELECT stop_id FROM initial_matches
                    WHERE parent_station IS NULL OR parent_station = ''
                )
                UNION
                SELECT s.stop_id FROM stops s
                WHERE s.parent_station IN (
                    SELECT parent_station FROM initial_matches
                    WHERE parent_station IS NOT NULL AND parent_station != ''
                )
            )
            SELECT
                s.stop_id AS id, s.stop_name AS name, s.stop_code,
                s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
                parent.stop_name AS parent_station_name,
                ST_Y(s.location::geometry) AS latitude,
                ST_X(s.location::geometry) AS longitude,
                ${distanceSelect}
            FROM stops s
            LEFT JOIN stops parent ON s.parent_station = parent.stop_id
            WHERE s.stop_id IN (SELECT stop_id FROM expanded)
              AND s.stop_code IS NOT NULL AND s.stop_code != ''
            ${orderBy}
            LIMIT 20;
        `, stopsQueryParams);

        // Routes — one row per direction, headsign from longest trip (= true terminus)
        const routesPromise = pool.query(`
            SELECT
                r.route_id,
                r.route_short_name,
                r.route_long_name,
                r.route_color,
                r.route_text_color,
                r.route_type,
                t.trip_headsign,
                t.direction_id,
                t.shape_id
            FROM routes r
            JOIN route_directions_precomputed t ON r.route_id = t.route_id
            WHERE r.route_short_name ILIKE $1 OR r.route_long_name ILIKE $1
            ORDER BY r.route_short_name, t.direction_id
            LIMIT 20;
        `, [searchQuery]);

        // Suburb routes — same direction-based distinct
        const suburbRoutesPromise = pool.query(`
            SELECT
                r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color, r.route_type,
                t.trip_headsign, t.direction_id, t.shape_id
            FROM routes r
            JOIN route_directions_precomputed t ON r.route_id = t.route_id
            WHERE r.route_id IN (
                SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
            )
            LIMIT 20;
        `, [searchQuery]);

        const [stopsResult, routesResult, suburbRoutesResult] = await Promise.all([stopsPromise, routesPromise, suburbRoutesPromise]);

        const allRoutes = [...routesResult.rows, ...suburbRoutesResult.rows];
        // Dedup on short name + direction — collapses multiple route_ids with the same
        // public-facing number (e.g. peak/off-peak variants) into one result per direction.
        const uniqueRoutes = Array.from(new Map(allRoutes.map(route => [`${route.route_short_name}-${route.direction_id}`, route])).values());

        res.json({ stops: stopsResult.rows, routes: uniqueRoutes });


    } catch (error) {
        console.error('v2 search query failed:', error);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

app.get('/api/stops-for-route', async (req, res) => {
    const { route_id, headsign } = req.query;
    if (!route_id || !headsign) { return res.status(400).json({ error: 'route_id and headsign are required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT s.stop_id as id, s.stop_name as name, s.stop_code, s.servicing_routes, s.route_directions,
                   ST_Y(s.location::geometry) AS latitude,
                   ST_X(s.location::geometry) AS longitude
            FROM stops s
            JOIN stop_times st ON s.stop_id = st.stop_id
            JOIN trips t ON st.trip_id = t.trip_id
            WHERE t.route_id = $1 AND t.trip_headsign = $2;
        `, [route_id, headsign]);
        res.json(rows);
    } catch (error) {
        console.error('Stops for route query failed:', error);
        res.status(500).json({ error: 'Failed to fetch stops for the route.' });
    }
});

app.get('/api/shapes-near-me', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon are required.' });
    const delta = 0.018; // ~2km bounding box in degrees
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT ON (r.route_id)
                r.route_id,
                r.route_color,
                ST_AsGeoJSON(ST_Simplify(rs.shape::geometry, 0.00008)) AS geojson
            FROM route_shapes rs
            JOIN trips t ON t.shape_id = rs.shape_id
            JOIN routes r ON r.route_id = t.route_id
            WHERE rs.shape && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            ORDER BY r.route_id
            LIMIT 30
        `, [lon - delta, lat - delta, lon + delta, lat + delta]);

        const result = rows.flatMap(row => {
            try {
                const geojson = JSON.parse(row.geojson);
                const toLatLon = c => [c[1], c[0]]; // GeoJSON is [lon,lat] → swap to [lat,lon]
                let points = [];
                if (geojson.type === 'LineString') {
                    points = geojson.coordinates.map(toLatLon);
                } else if (geojson.type === 'MultiLineString') {
                    points = geojson.coordinates.flat().map(toLatLon);
                }
                if (points.length < 2) return [];
                return [{ routeId: row.route_id, routeColor: row.route_color, points }];
            } catch { return []; }
        });

        res.json(result);
    } catch (error) {
        console.error('shapes-near-me failed:', error);
        res.json([]);
    }
});

app.get('/api/route-shape', async (req, res) => {
    const { shape_id } = req.query;
    if (!shape_id) { return res.status(400).json({ error: 'shape_id is required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT ST_AsGeoJSON(shape) as shape_geojson
            FROM route_shapes
            WHERE shape_id = $1;
        `, [shape_id]);
        res.json(rows[0] ? JSON.parse(rows[0].shape_geojson) : null);
    } catch (error) {
        console.error('Route shape query failed:', error);
        res.status(500).json({ error: 'Failed to fetch route shape.' });
    }
});

app.get('/api/route-info', async (req, res) => {
    const { route_id } = req.query;
    if (!route_id) {
        return res.status(400).json({ error: 'route_id is required.' });
    }
    try {
        const { rows } = await pool.query(`
            SELECT route_short_name, route_long_name, route_color, route_text_color
            FROM routes
            WHERE route_id = $1;
        `, [route_id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ error: 'Route not found.' });
        }
    } catch (error) {
        console.error('Route info query failed:', error);
        res.status(500).json({ error: 'Failed to fetch route info.' });
    }
});

app.get('/api/stops-for-route-at-station', async (req, res) => {
    const { route_id, headsign, parent_station } = req.query;
    if (!route_id || !headsign || !parent_station) {
        return res.status(400).json({ error: 'route_id, headsign, and parent_station are required.' });
    }
    try {
        // Find all child stops of the parent station that are serviced by the specific route and headsign.
        const { rows } = await pool.query(`
            SELECT s.stop_id as id, s.stop_name as name, s.stop_code, s.parent_station,
                   ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
            FROM stops s
            WHERE s.parent_station = $1
              AND s.stop_id IN (
                SELECT DISTINCT st.stop_id
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE t.route_id = $2 AND t.trip_headsign = $3
              );
        `, [parent_station, route_id, headsign]);
        res.json(rows);
    } catch (error) {
        console.error('Stops for route at station query failed:', error);
        res.status(500).json({ error: 'Failed to fetch stops for the route at the specified station.' });
    }
});

app.get('/api/routes-for-stops', async (req, res) => {
    const { stop_codes } = req.query;
    if (!stop_codes) {
        return res.status(400).json({ error: 'stop_codes are required.' });
    }
    try {
        const stopCodesArray = stop_codes.split(',');
        const { rows } = await pool.query(`
            SELECT DISTINCT r.route_short_name, r.route_type, r.route_color, r.route_text_color
            FROM routes r
            JOIN trips t ON r.route_id = t.route_id
            JOIN stop_times st ON t.trip_id = st.trip_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE s.stop_code = ANY($1::text[])
            ORDER BY r.route_type, r.route_short_name;
        `, [stopCodesArray]);
        res.json(rows);
    } catch (error) {
        console.error('Routes for stops query failed:', error);
        res.status(500).json({ error: 'Failed to fetch routes for the specified stops.' });
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
             parent_stop.stop_name AS parent_station_name, ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric)::int AS distance_m,
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
                t.trip_headsign, t.direction_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
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
            let isDelayed = false;

            if (stopTimeUpdates) {
                const stopUpdate = stopTimeUpdates.find(stu => stu.stopSequence === s.stop_sequence);
                if (stopUpdate && stopUpdate.departure) {
                    if (stopUpdate.departure.time) {
                        // The 'time' object from protobufjs is a Long.js object.
                        // We must convert it to a standard JavaScript number before using it.
                        let departureTimestamp = stopUpdate.departure.time;
                        if (typeof departureTimestamp === 'object' && typeof departureTimestamp.toNumber === 'function') {
                            departureTimestamp = departureTimestamp.toNumber();
                        }
                        expectedUtc = new Date(departureTimestamp * 1000).toISOString();
                    }
                    // Use GTFS-RT delay field — positive value means explicitly delayed
                    const rawDelay = stopUpdate.departure.delay;
                    const delaySeconds = (typeof rawDelay === 'object' && rawDelay?.toNumber)
                        ? rawDelay.toNumber()
                        : (Number(rawDelay) || 0);
                    isDelayed = delaySeconds > 0;
                }
            }
            const secondsUntil = Math.round((new Date(expectedUtc) - synchronizedNow) / 1000);
            
            let vehicleType = 'Train';
            if (s.route_type === 3) vehicleType = 'Bus';
            if (s.route_type === 4) vehicleType = 'Ferry';

            return {
                trip_id: s.trip_id,
                stop_id: s.stop_id,
                stop_sequence: s.stop_sequence,
                stopName: s.stop_name,
                vehicleType: vehicleType,
                routeNumber: s.route_short_name,
                directionId: s.direction_id,
                headsign: s.trip_headsign,
                scheduledDepartureUtc: scheduledUtc.toISOString(),
                expectedDepartureUtc: (expectedUtc !== scheduledUtc.toISOString()) ? expectedUtc : null,
                isDelayed: isDelayed,
                secondsUntilDeparture: secondsUntil,
                routeLongName: s.route_long_name,
                routeColor: s.route_color,
                routeTextColor: s.route_text_color,
                platformCode:s.platform_code
            };
        });
        
        let sorted = enrichedDepartures
            .filter(dep => dep.secondsUntilDeparture > -120)
            .sort((a, b) => a.secondsUntilDeparture - b.secondsUntilDeparture);

        // Filter to trips that actually call at the get-off stop(s).
        // Accepts a comma-separated list of stop_ids to support multi-platform stations.
        if (req.query.get_off_stop) {
            const getOffStopIds = req.query.get_off_stop.split(',').map(s => s.trim()).filter(Boolean);
            const tripIds = [...new Set(sorted.map(d => d.trip_id))];
            if (tripIds.length > 0 && getOffStopIds.length > 0) {
                const { rows: validRows } = await pool.query(
                    'SELECT DISTINCT trip_id FROM stop_times WHERE trip_id = ANY($1) AND stop_id = ANY($2)',
                    [tripIds, getOffStopIds]
                );
                const validTripIds = new Set(validRows.map(r => r.trip_id));
                sorted = sorted.filter(d => validTripIds.has(d.trip_id));
            }
        }

        const perStop = parseInt(req.query.per_stop, 10) || null;
        if (perStop) {
            // Per-stop mode: guarantees every stop gets at least one departure,
            // even for infrequent platforms with service hours away.
            const countPerStop = new Map();
            const result = [];
            for (const dep of sorted) {
                const n = countPerStop.get(dep.stop_id) ?? 0;
                if (n < perStop) {
                    result.push(dep);
                    countPerStop.set(dep.stop_id, n + 1);
                }
            }
            res.json(result);
        } else {
            res.json(sorted.slice(0, 15));
        }
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