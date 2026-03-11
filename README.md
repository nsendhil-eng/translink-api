# Brisbane Transit API

Node.js/Express backend for the Brisbane Transit apps. Deployed on **Vercel** at `https://transit.sn-app.space`. Uses **PostgreSQL + PostGIS** with Translink SEQ GTFS data.

## Running locally

```bash
node index.js   # starts on port 3001
```

Requires a `.env` file with `POSTGRES_URL` pointing to the Vercel Postgres database.

## Deploying

Changes must be pushed to GitHub — Vercel auto-deploys on push to `main`.

```bash
git add -A && git commit -m "..." && git push
```

## API Endpoints

| Endpoint | Notes |
|----------|-------|
| `GET /api/search` | Web app only — **do not modify** |
| `GET /api/v2/search` | iOS + Android. DISTINCT ON (route_id, trip_headsign). Supports `lat`/`lon` for distance ordering |
| `GET /api/departures` | All clients. Params: `stops`, `per_stop`, `get_off_stop`. Returns `routeId` |
| `GET /api/trip-stops` | Accepts `trip_id` OR `route_id`+`direction_id`+`user_lat`/`user_lon` |
| `GET /api/next-trips` | Next ~5 trips for a route+direction at a stop |
| `GET /api/stops-near-me` | `lat`, `lon`, `radius` (default 500m) |
| `GET /api/stop-live` | GTFS-RT realtime data (vehicle position + shape) for a stop |
| `GET /api/vehicles-near-me` | Vehicle positions, cached 4s |
| `GET /api/plan` | Journey planner — proxies to OTP on Hetzner |
| `GET /api/plan-delays` | GTFS-RT departure delays for given `trip_ids` (15s cache) |

### Journey Planner (`/api/plan`)

Proxies to OpenTripPlanner 2.6.0 on Hetzner:

```
GET /api/plan?fromLat=&fromLon=&toLat=&toLon=&date=YYYY-MM-DD&time=8:30am
```

- Returns up to 5 itineraries, transit-first (walk-only sorted to back)
- `walkReluctance=5`, `maxWalkDistance=1500`

### Delay Check (`/api/plan-delays`)

```
GET /api/plan-delays?trip_ids=T1,T2,T3
```

Returns `{ delays: { tripId: delaySecs } }` — only trips with delay > 0. Used by clients to show traffic delay warnings on itinerary cards.

## Web App

Static files served from `public/`:

| File | Purpose |
|------|---------|
| `public/index.html` + `public/app.js` | Main departures board |
| `public/plan.html` + `public/plan.js` | Standalone journey planner |
| `public/routes.html` | Favourite routes manager |
| `public/help.html` | Help page |

## Testing the Planner

```bash
node scripts/test-planner.js                 # tests against production
node scripts/test-planner.js --local         # tests against localhost:3001
node scripts/test-planner.js --time "9:00am" # override departure time
```

Runs 8 real Brisbane journeys and compares against expected transport modes.

## OTP Server (Hetzner)

| Item | Value |
|------|-------|
| Provider | Hetzner CX22, Helsinki |
| IP | `65.109.234.125` |
| SSH | `ssh root@65.109.234.125` |
| OTP version | 2.6.0, Java 21 |
| Graph | `/root/otp/graphs/seq/graph.obj` (SEQ GTFS + OSM) |
| Service | `systemctl status otp` / `systemctl restart otp` |
| Logs | `journalctl -u otp -f` |
| Auto-rebuild | Weekly cron Sun 3am: `bash /root/otp/rebuild.sh` |

**Manual graph rebuild:**
```bash
ssh root@65.109.234.125
cd /root/otp && bash rebuild.sh
```

**Health check:**
```bash
curl "http://65.109.234.125:8080/otp/routers/default/plan?fromPlace=-27.47,153.02&toPlace=-27.48,153.03&mode=TRANSIT,WALK&numItineraries=1"
```
