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
const VEHICLE_POSITIONS_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions';
const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

// Cache vehicle positions for 4 s so rapid polls don't hammer Translink
let vehiclePositionsCache = null;
let vehiclePositionsCacheTime = 0;

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

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

        // Split query into tokens for order-independent matching
        // e.g. "stop 10 ann" matches "Ann Street Stop 10"
        const tokens = q.trim().split(/\s+/).filter(t => t.length >= 1);
        const tokenPatterns = tokens.map(t => `%${t}%`);
        const nameTokenConds = tokenPatterns.map((_, i) => `stop_name ILIKE $${i + 1}`).join(' AND ');
        const descTokenConds = tokenPatterns.map((_, i) => `COALESCE(stop_desc, '') ILIKE $${i + 1}`).join(' AND ');
        const stopTokenCondition = `(${nameTokenConds}) OR (${descTokenConds})`;
        const locOffset = tokenPatterns.length;

        const stopsQueryParams = hasLocation ? [...tokenPatterns, lon, lat] : tokenPatterns;
        const distanceSelect = hasLocation
            ? `ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($${locOffset + 1}, $${locOffset + 2}), 4326)::geography))::int AS distance_m`
            : `NULL::int AS distance_m`;
        const orderBy = hasLocation ? `ORDER BY distance_m ASC NULLS LAST` : `ORDER BY s.stop_name`;

        const stopsPromise = pool.query(`
            WITH initial_matches AS (
                SELECT stop_id, parent_station
                FROM stops
                WHERE ${stopTokenCondition}
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

        // Routes — one row per unique headsign, surfaces all destination variants
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
            JOIN (
                SELECT DISTINCT ON (t2.route_id, t2.trip_headsign)
                    t2.route_id, t2.trip_headsign, t2.direction_id, t2.shape_id
                FROM trips t2
                WHERE t2.route_id IN (
                    SELECT route_id FROM routes
                    WHERE route_short_name ILIKE $1 OR route_long_name ILIKE $1
                )
                ORDER BY t2.route_id, t2.trip_headsign
            ) t ON r.route_id = t.route_id
            WHERE r.route_short_name ILIKE $1 OR r.route_long_name ILIKE $1
            ORDER BY r.route_short_name, t.trip_headsign
            LIMIT 20;
        `, [searchQuery]);

        // Suburb routes — same headsign-based distinct
        const suburbRoutesPromise = pool.query(`
            SELECT
                r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color, r.route_type,
                t.trip_headsign, t.direction_id, t.shape_id
            FROM routes r
            JOIN (
                SELECT DISTINCT ON (t2.route_id, t2.trip_headsign)
                    t2.route_id, t2.trip_headsign, t2.direction_id, t2.shape_id
                FROM trips t2
                WHERE t2.route_id IN (
                    SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
                )
                ORDER BY t2.route_id, t2.trip_headsign
            ) t ON r.route_id = t.route_id
            WHERE r.route_id IN (
                SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
            )
            LIMIT 20;
        `, [searchQuery]);

        const [stopsResult, routesResult, suburbRoutesResult] = await Promise.all([stopsPromise, routesPromise, suburbRoutesPromise]);

        const allRoutes = [...routesResult.rows, ...suburbRoutesResult.rows];
        // Dedup on route_id + headsign — one result per unique destination
        const uniqueRoutes = Array.from(new Map(allRoutes.map(route => [`${route.route_id}-${route.trip_headsign}`, route])).values());

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

app.get('/api/vehicles-near-me', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 1000;
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon are required.' });

    try {
        // Refresh the feed at most once per 4 s
        if (!vehiclePositionsCache || Date.now() - vehiclePositionsCacheTime > 4000) {
            const r = await fetch(VEHICLE_POSITIONS_URL, fetchOptions);
            const buf = await r.arrayBuffer();
            vehiclePositionsCache = gtfsRealtime.decode(Buffer.from(buf));
            vehiclePositionsCacheTime = Date.now();
        }

        // Filter to vehicles within radius
        const nearby = [];
        for (const entity of vehiclePositionsCache.entity) {
            const v = entity.vehicle;
            if (!v?.position) continue;
            const vLat = v.position.latitude;
            const vLon = v.position.longitude;
            if (typeof vLat !== 'number' || typeof vLon !== 'number') continue;
            if (haversineMeters(lat, lon, vLat, vLon) > radius) continue;
            nearby.push({
                vehicleId: entity.id,
                lat: vLat,
                lon: vLon,
                bearing: v.position.bearing ?? 0,
                tripId: v.trip?.tripId ?? null,
            });
        }

        if (nearby.length === 0) return res.json([]);

        // Enrich with route info from the DB
        const tripIds = nearby.map(v => v.tripId).filter(Boolean);
        const routeByTrip = {};
        if (tripIds.length > 0) {
            const { rows } = await pool.query(`
                SELECT t.trip_id, r.route_short_name, r.route_color, r.route_type
                FROM trips t
                JOIN routes r ON r.route_id = t.route_id
                WHERE t.trip_id = ANY($1)
            `, [tripIds]);
            for (const row of rows) routeByTrip[row.trip_id] = row;
        }

        const result = nearby.map(v => {
            const route = (v.tripId && routeByTrip[v.tripId]) || {};
            return {
                vehicleId: v.vehicleId,
                lat: v.lat,
                lon: v.lon,
                bearing: v.bearing,
                routeShortName: route.route_short_name ?? '',
                routeColor: route.route_color ?? null,
                routeType: route.route_type ?? 3,
            };
        });

        res.json(result);
    } catch (error) {
        console.error('vehicles-near-me failed:', error);
        res.json([]);
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
                t.trip_headsign, t.direction_id, r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
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
                routeId: s.route_id,
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


// --- STOP LIVE: shapes + vehicle positions for the next 2 departures at a stop ---
// GET /api/stop-live?stop_ids=id1,id2
// Returns up to 2 upcoming trips, each with split shape (before/after stop) and GTFS-RT vehicle position.
app.get('/api/stop-live', async (req, res) => {
    const stopIdsParam = req.query.stop_ids || req.query.stop_id;
    if (!stopIdsParam) return res.status(400).json({ error: 'stop_ids is required.' });
    const stopIds = stopIdsParam.split(',').map(s => s.trim()).filter(Boolean);

    try {
        const now = new Date();
        const timeZone = 'Australia/Brisbane';
        const parts = new Intl.DateTimeFormat('en-AU', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
        }).formatToParts(now);
        const findPart = (type) => parts.find(p => p.type === type)?.value || '';
        const dayOfWeek = findPart('weekday').toLowerCase();
        const dateString = `${findPart('year')}${findPart('month')}${findPart('day')}`;

        // Fetch all of today's trips for these stops (time filter done in JS to handle > 24h GTFS times)
        const { rows: allRows } = await pool.query(`
            SELECT
                st.trip_id, st.stop_id, st.stop_sequence, st.departure_time,
                t.shape_id,
                r.route_short_name, r.route_color, r.route_type,
                ST_Y(s.location::geometry) AS stop_lat,
                ST_X(s.location::geometry) AS stop_lon
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE st.stop_id = ANY($1)
            AND t.service_id IN (
                (SELECT service_id FROM calendar
                 WHERE start_date <= $2 AND end_date >= $2 AND ${dayOfWeek} = 1)
                EXCEPT
                (SELECT service_id FROM calendar_dates WHERE date = $2 AND exception_type = 2)
                UNION
                (SELECT service_id FROM calendar_dates WHERE date = $2 AND exception_type = 1)
            )
            ORDER BY st.departure_time
        `, [stopIds, dateString]);

        // Convert GTFS departure_time to UTC, filter to upcoming, take first 2
        const year = parseInt(dateString.substring(0, 4));
        const month = parseInt(dateString.substring(4, 6)) - 1;
        const day = parseInt(dateString.substring(6, 8));
        const synchronizedNow = new Date();
        const upcoming = allRows
            .map(row => {
                const [h, m, sec] = row.departure_time.split(':').map(Number);
                const scheduledUtc = new Date(Date.UTC(year, month, day));
                scheduledUtc.setUTCHours(h - 10, m, sec); // Brisbane = UTC+10
                return { ...row, secondsUntil: Math.round((scheduledUtc - synchronizedNow) / 1000) };
            })
            .filter(row => row.secondsUntil > -60)
            .slice(0, 2);

        if (upcoming.length === 0) return res.json({ trips: [] });

        // Refresh vehicle positions cache if stale
        if (!vehiclePositionsCache || Date.now() - vehiclePositionsCacheTime > 4000) {
            const r = await fetch(VEHICLE_POSITIONS_URL, fetchOptions);
            const buf = await r.arrayBuffer();
            vehiclePositionsCache = gtfsRealtime.decode(Buffer.from(buf));
            vehiclePositionsCacheTime = Date.now();
        }

        // Build trip_id → vehicle map from GTFS-RT
        const vehicleByTrip = {};
        for (const entity of vehiclePositionsCache.entity) {
            const v = entity.vehicle;
            if (!v?.position || !v?.trip?.tripId) continue;
            vehicleByTrip[v.trip.tripId] = {
                lat: v.position.latitude,
                lon: v.position.longitude,
                bearing: v.position.bearing ?? 0,
                currentStopSequence: v.currentStopSequence ?? 0,
            };
        }

        // For each upcoming trip: get shape, split at stop, attach vehicle
        const trips = await Promise.all(upcoming.map(async (row) => {
            // Get simplified shape as GeoJSON from route_shapes
            const { rows: shapeRows } = await pool.query(`
                SELECT ST_AsGeoJSON(ST_Simplify(shape::geometry, 0.00008)) AS geojson
                FROM route_shapes
                WHERE shape_id = $1
            `, [row.shape_id]);

            let shapeBefore = [];
            let shapeAfter = [];

            if (shapeRows.length > 0) {
                try {
                    const geojson = JSON.parse(shapeRows[0].geojson);
                    // GeoJSON is [lon, lat] — swap to [lat, lon] for the app
                    const toLatLon = c => [c[1], c[0]];
                    let points = [];
                    if (geojson.type === 'LineString') {
                        points = geojson.coordinates.map(toLatLon);
                    } else if (geojson.type === 'MultiLineString') {
                        points = geojson.coordinates.flat().map(toLatLon);
                    }

                    // Find shape point closest to the stop → split index
                    const stopLat = parseFloat(row.stop_lat);
                    const stopLon = parseFloat(row.stop_lon);
                    let splitIdx = 0;
                    let minDist = Infinity;
                    for (let i = 0; i < points.length; i++) {
                        const d = haversineMeters(stopLat, stopLon, points[i][0], points[i][1]);
                        if (d < minDist) { minDist = d; splitIdx = i; }
                    }
                    shapeBefore = points.slice(0, splitIdx + 1);
                    shapeAfter = points.slice(splitIdx);
                } catch { /* leave empty */ }
            }

            const liveVehicle = vehicleByTrip[row.trip_id] ?? null;
            const hasPassed = liveVehicle
                ? liveVehicle.currentStopSequence > row.stop_sequence
                : false;

            return {
                tripId: row.trip_id,
                routeShortName: row.route_short_name ?? '',
                routeColor: row.route_color ?? null,
                shapeBefore,
                shapeAfter,
                vehicle: liveVehicle ? {
                    lat: liveVehicle.lat,
                    lon: liveVehicle.lon,
                    bearing: liveVehicle.bearing,
                } : null,
                hasPassed,
            };
        }));

        res.json({ trips });
    } catch (error) {
        console.error('stop-live failed:', error);
        res.json({ trips: [] });
    }
});

// --- TRIP STOPS ENDPOINT ---
// GET /api/trip-stops?trip_id=X
// GET /api/trip-stops?route_id=X&direction_id=Y&user_lat=Z&user_lon=W
// Returns full stop list with scheduled/estimated times + simplified shape
app.get('/api/trip-stops', async (req, res) => {
    let { trip_id, route_id, direction_id, user_lat, user_lon } = req.query;
    const userLat = parseFloat(user_lat);
    const userLon = parseFloat(user_lon);
    const hasLocation = !isNaN(userLat) && !isNaN(userLon);

    try {
        const now = new Date();
        const timeZone = 'Australia/Brisbane';
        const parts = new Intl.DateTimeFormat('en-AU', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
        }).formatToParts(now);
        const findPart = (type) => parts.find(p => p.type === type)?.value || '';
        const dayOfWeek = findPart('weekday').toLowerCase();
        const dateString = `${findPart('year')}${findPart('month')}${findPart('day')}`;
        const year = parseInt(dateString.substring(0, 4));
        const month = parseInt(dateString.substring(4, 6)) - 1;
        const day = parseInt(dateString.substring(6, 8));
        const syncNow = new Date();

        const formatBrisbane = (utcDate) =>
            new Intl.DateTimeFormat('en-AU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(utcDate);

        // If route_id given without trip_id: find nearest stop on route, then next upcoming trip
        if (!trip_id && route_id) {
            const dirId = parseInt(direction_id) || 0;
            let nearestStopId = null;

            if (hasLocation) {
                const { rows: nearbyStops } = await pool.query(`
                    SELECT DISTINCT s.stop_id,
                           ST_Distance(s.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS dist
                    FROM stops s
                    JOIN stop_times st ON s.stop_id = st.stop_id
                    JOIN trips t ON st.trip_id = t.trip_id
                    WHERE t.route_id = $1 AND t.direction_id = $2
                    ORDER BY dist ASC
                    LIMIT 1
                `, [route_id, dirId, userLon, userLat]);
                nearestStopId = nearbyStops[0]?.stop_id || null;
            }

            if (!nearestStopId) {
                // Fall back to any stop on the route
                const { rows } = await pool.query(`
                    SELECT DISTINCT s.stop_id FROM stops s
                    JOIN stop_times st ON s.stop_id = st.stop_id
                    JOIN trips t ON st.trip_id = t.trip_id
                    WHERE t.route_id = $1 AND t.direction_id = $2 LIMIT 1
                `, [route_id, dirId]);
                nearestStopId = rows[0]?.stop_id || null;
            }

            if (!nearestStopId) return res.status(404).json({ error: 'No stops found for this route/direction.' });

            const { rows: tripRows } = await pool.query(`
                SELECT st.trip_id, st.departure_time
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE st.stop_id = $1
                  AND t.route_id = $2 AND t.direction_id = $3
                  AND t.service_id IN (
                    (SELECT service_id FROM calendar WHERE start_date <= $4 AND end_date >= $4 AND ${dayOfWeek} = 1)
                    EXCEPT (SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = 2)
                    UNION (SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = 1)
                  )
                ORDER BY st.departure_time
            `, [nearestStopId, route_id, dirId, dateString]);

            for (const tr of tripRows) {
                const [h, m, sec] = tr.departure_time.split(':').map(Number);
                const scheduledUtc = new Date(Date.UTC(year, month, day));
                scheduledUtc.setUTCHours(h - 10, m, sec);
                if ((scheduledUtc - syncNow) / 1000 > -60) { trip_id = tr.trip_id; break; }
            }
            if (!trip_id) return res.status(404).json({ error: 'No upcoming trips found.' });
        }

        if (!trip_id) return res.status(400).json({ error: 'trip_id or (route_id + direction_id) required.' });

        // Parallel: trip info, stop list, GTFS-RT trip updates + vehicle positions
        const [tripInfoResult, stopResult, liveResponse, vehicleResponse] = await Promise.all([
            pool.query(`
                SELECT t.trip_id, t.route_id, t.trip_headsign, t.direction_id, t.shape_id,
                       r.route_short_name, r.route_color, r.route_type
                FROM trips t JOIN routes r ON r.route_id = t.route_id WHERE t.trip_id = $1
            `, [trip_id]),
            pool.query(`
                SELECT st.stop_sequence, st.departure_time, s.stop_id, s.stop_name,
                       ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lon
                FROM stop_times st JOIN stops s ON st.stop_id = s.stop_id
                WHERE st.trip_id = $1 ORDER BY st.stop_sequence
            `, [trip_id]),
            fetch(REALTIME_URL, fetchOptions),
            fetch(VEHICLE_POSITIONS_URL, fetchOptions)
        ]);

        if (tripInfoResult.rows.length === 0) return res.status(404).json({ error: 'Trip not found.' });
        const tripInfo = tripInfoResult.rows[0];

        // Parse GTFS-RT trip updates
        const buffer = await liveResponse.arrayBuffer();
        const feed = gtfsRealtime.decode(Buffer.from(buffer));
        const stopTimeUpdateMap = new Map();
        for (const entity of feed.entity) {
            if (entity.tripUpdate?.trip?.tripId === trip_id) {
                for (const stu of (entity.tripUpdate.stopTimeUpdate || [])) {
                    stopTimeUpdateMap.set(stu.stopSequence, stu);
                }
                break;
            }
        }

        // Parse GTFS-RT vehicle positions
        let vehicle = null;
        try {
            const vBuffer = await vehicleResponse.arrayBuffer();
            const vFeed = gtfsRealtime.decode(Buffer.from(vBuffer));
            for (const entity of vFeed.entity) {
                if (entity.vehicle?.trip?.tripId === trip_id) {
                    const pos = entity.vehicle.position;
                    if (pos) {
                        vehicle = {
                            lat: pos.latitude,
                            lon: pos.longitude,
                            bearing: pos.bearing || 0
                        };
                    }
                    break;
                }
            }
        } catch (e) { /* vehicle position not critical */ }

        // Get shape
        let shape = [];
        if (tripInfo.shape_id) {
            const { rows: shapeRows } = await pool.query(`
                SELECT ST_AsGeoJSON(ST_Simplify(shape::geometry, 0.00008)) AS geojson
                FROM route_shapes WHERE shape_id = $1
            `, [tripInfo.shape_id]);
            if (shapeRows[0]?.geojson) {
                try {
                    const geo = JSON.parse(shapeRows[0].geojson);
                    const toLatLon = c => [c[1], c[0]];
                    if (geo.type === 'LineString') shape = geo.coordinates.map(toLatLon);
                    else if (geo.type === 'MultiLineString') shape = geo.coordinates.flat().map(toLatLon);
                } catch {}
            }
        }

        // Build stops array
        let nearestUpcomingIdx = -1;
        let minDist = Infinity;

        const stops = stopResult.rows.map((s, idx) => {
            const [h, m, sec] = s.departure_time.split(':').map(Number);
            const scheduledUtc = new Date(Date.UTC(year, month, day));
            scheduledUtc.setUTCHours(h - 10, m, sec);

            let estimatedUtc = scheduledUtc;
            const stu = stopTimeUpdateMap.get(s.stop_sequence);
            if (stu?.departure?.time) {
                let ts = stu.departure.time;
                if (typeof ts === 'object' && ts.toNumber) ts = ts.toNumber();
                estimatedUtc = new Date(ts * 1000);
            }

            const secondsUntil = Math.round((estimatedUtc - syncNow) / 1000);
            const isUpcoming = secondsUntil > -60;

            if (isUpcoming && hasLocation) {
                const dist = haversineMeters(userLat, userLon, parseFloat(s.lat), parseFloat(s.lon));
                if (dist < minDist) { minDist = dist; nearestUpcomingIdx = idx; }
            }

            const scheduledTime = formatBrisbane(scheduledUtc);
            const estimatedTime = formatBrisbane(estimatedUtc);

            return {
                stopId: s.stop_id,
                stopName: s.stop_name,
                lat: parseFloat(s.lat),
                lon: parseFloat(s.lon),
                scheduledTime,
                estimatedTime: estimatedTime !== scheduledTime ? estimatedTime : null,
                estimatedUtc: estimatedUtc.toISOString(),
                secondsUntil,
                isUpcoming,
                isNearest: false
            };
        });

        // Mark nearest upcoming stop (or first upcoming if no location)
        if (nearestUpcomingIdx >= 0) {
            stops[nearestUpcomingIdx].isNearest = true;
        } else {
            const firstUpcoming = stops.findIndex(s => s.isUpcoming);
            if (firstUpcoming >= 0) stops[firstUpcoming].isNearest = true;
        }

        res.json({
            tripInfo: {
                tripId: tripInfo.trip_id,
                routeId: tripInfo.route_id,
                routeShortName: tripInfo.route_short_name,
                routeColor: tripInfo.route_color,
                routeType: tripInfo.route_type,
                headsign: tripInfo.trip_headsign,
                directionId: tripInfo.direction_id
            },
            shape,
            stops,
            vehicle
        });
    } catch (error) {
        console.error('trip-stops failed:', error);
        res.status(500).json({ error: 'Failed to fetch trip stops.' });
    }
});

// --- NEXT TRIPS ENDPOINT ---
// GET /api/next-trips?route_id=X&direction_id=Y&stop_id=Z
// Returns next ~5 upcoming trips for this route+direction at the given stop
app.get('/api/next-trips', async (req, res) => {
    const { route_id, stop_id } = req.query;
    const direction_id = parseInt(req.query.direction_id);
    if (!route_id || isNaN(direction_id) || !stop_id) {
        return res.status(400).json({ error: 'route_id, direction_id, and stop_id are required.' });
    }

    try {
        const now = new Date();
        const timeZone = 'Australia/Brisbane';
        const parts = new Intl.DateTimeFormat('en-AU', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
        }).formatToParts(now);
        const findPart = (type) => parts.find(p => p.type === type)?.value || '';
        const dayOfWeek = findPart('weekday').toLowerCase();
        const dateString = `${findPart('year')}${findPart('month')}${findPart('day')}`;
        const year = parseInt(dateString.substring(0, 4));
        const month = parseInt(dateString.substring(4, 6)) - 1;
        const day = parseInt(dateString.substring(6, 8));
        const syncNow = new Date();

        const formatBrisbane = (utcDate) =>
            new Intl.DateTimeFormat('en-AU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(utcDate);

        const [stopsResult, liveResponse] = await Promise.all([
            pool.query(`
                SELECT st.trip_id, st.departure_time, st.stop_sequence
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE st.stop_id = $1
                  AND t.route_id = $2 AND t.direction_id = $3
                  AND t.service_id IN (
                    (SELECT service_id FROM calendar WHERE start_date <= $4 AND end_date >= $4 AND ${dayOfWeek} = 1)
                    EXCEPT (SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = 2)
                    UNION (SELECT service_id FROM calendar_dates WHERE date = $4 AND exception_type = 1)
                  )
                ORDER BY st.departure_time
            `, [stop_id, route_id, direction_id, dateString]),
            fetch(REALTIME_URL, fetchOptions)
        ]);

        const buffer = await liveResponse.arrayBuffer();
        const feed = gtfsRealtime.decode(Buffer.from(buffer));
        const liveDataMap = new Map();
        feed.entity.forEach(entity => {
            if (entity.tripUpdate) liveDataMap.set(entity.tripUpdate.trip.tripId, entity.tripUpdate.stopTimeUpdate);
        });

        const trips = [];
        for (const row of stopsResult.rows) {
            if (trips.length >= 5) break;
            const [h, m, sec] = row.departure_time.split(':').map(Number);
            const scheduledUtc = new Date(Date.UTC(year, month, day));
            scheduledUtc.setUTCHours(h - 10, m, sec);
            const secondsUntil = Math.round((scheduledUtc - syncNow) / 1000);
            if (secondsUntil < -60) continue;

            const scheduledTime = formatBrisbane(scheduledUtc);
            let estimatedTime = null;

            const stopUpdates = liveDataMap.get(row.trip_id);
            if (stopUpdates) {
                const stu = stopUpdates.find(u => u.stopSequence === row.stop_sequence);
                if (stu?.departure?.time) {
                    let ts = stu.departure.time;
                    if (typeof ts === 'object' && ts.toNumber) ts = ts.toNumber();
                    const estTime = formatBrisbane(new Date(ts * 1000));
                    if (estTime !== scheduledTime) estimatedTime = estTime;
                }
            }

            trips.push({ tripId: row.trip_id, scheduledTime, estimatedTime });
        }

        res.json({ trips });
    } catch (error) {
        console.error('next-trips failed:', error);
        res.status(500).json({ error: 'Failed to fetch next trips.' });
    }
});

// --- PLAN ENDPOINT ---
// GET /api/plan?fromLat=X&fromLon=Y&toLat=A&toLon=B&time=08:00am&date=2026-03-09
// Proxies to OTP and returns cleaned itineraries
const OTP_URL = process.env.OTP_URL || 'http://65.109.234.125:8080';

app.get('/api/plan', async (req, res) => {
    const { fromLat, fromLon, toLat, toLon, time, date, modes } = req.query;
    if (!fromLat || !fromLon || !toLat || !toLon) {
        return res.status(400).json({ error: 'fromLat, fromLon, toLat, toLon are required.' });
    }
    const planDate = date || new Date().toISOString().slice(0, 10);
    const planTime = time || '8:00am';
    const planModes = modes || 'TRANSIT,WALK';

    try {
        const otpUrl = `${OTP_URL}/otp/routers/default/plan` +
            `?fromPlace=${fromLat},${fromLon}` +
            `&toPlace=${toLat},${toLon}` +
            `&time=${encodeURIComponent(planTime)}` +
            `&date=${planDate}` +
            `&mode=${planModes}` +
            `&numItineraries=5` +
            `&walkReluctance=5` +
            `&maxWalkDistance=1500`;

        const otpRes = await fetch(otpUrl, { headers: { 'User-Agent': 'WayGo/1.0' } });
        if (!otpRes.ok) return res.status(502).json({ error: 'OTP request failed.' });

        const data = await otpRes.json();
        const itineraries = (data.plan?.itineraries || []).map(it => ({
            duration: it.duration,
            startTime: it.startTime,
            endTime: it.endTime,
            walkDistance: Math.round(it.walkDistance),
            transfers: it.transfers,
            legs: it.legs.map(leg => ({
                mode: leg.mode,
                startTime: leg.startTime,
                endTime: leg.endTime,
                duration: Math.round(leg.duration),
                distance: Math.round(leg.distance),
                from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon, stopCode: leg.from.stopCode },
                to:   { name: leg.to.name,   lat: leg.to.lat,   lon: leg.to.lon,   stopCode: leg.to.stopCode   },
                routeShortName: leg.routeShortName || null,
                routeLongName:  leg.routeLongName  || null,
                routeColor:     leg.routeColor     || null,
                headsign:       leg.headsign       || null,
                tripId:         leg.tripId         || null,
                legGeometry:    leg.legGeometry?.points || null,
                steps: (leg.steps || []).map(s => ({
                    distance: Math.round(s.distance),
                    streetName: s.streetName,
                    relativeDirection: s.relativeDirection,
                    absoluteDirection: s.absoluteDirection
                }))
            }))
        }));

        const TRANSIT_MODES = new Set(['BUS','RAIL','TRAM','FERRY','SUBWAY','GONDOLA','FUNICULAR','CABLE_CAR']);
        const hasTransit = it => it.legs.some(l => TRANSIT_MODES.has(l.mode));

        // Put transit itineraries first; walk-only fall to the back
        const sorted = [
            ...itineraries.filter(hasTransit),
            ...itineraries.filter(it => !hasTransit(it))
        ];

        res.json({ itineraries: sorted });
    } catch (error) {
        console.error('plan failed:', error);
        res.status(500).json({ error: 'Failed to fetch journey plan.' });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});