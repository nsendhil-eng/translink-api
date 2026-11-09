#!/usr/bin/env python3
"""
Load businesses and named places for SEQ from Overture Maps into Postgres (table `places`),
for /api/places to search alongside Photon. Photon (OpenStreetMap) is good at addresses, streets
and landmarks but misses many businesses ("Rochedale Central Dentist"); Overture has them.

  pip install duckdb
  POSTGRES_URL_NON_POOLING=postgres://... python3 scripts/import-places.py [--release 2026-10-21.0] [--dry-run]

Reads Overture's free public GeoParquet on S3 (no account), keeps places with confidence >= 0.7
that aren't closed, drops one-person "home service" listings (usually a home or suburb centre,
not somewhere to travel to), places with no street address (often pinned at a suburb's centre)
and repeats of one place, loads them into places_new, checks the
count, then swaps it in for `places` in one transaction. A failed run leaves `places` as it was.

Licences: Overture places are CDLA-Permissive-2.0, with Foursquare-sourced rows Apache-2.0 and
AllThePlaces rows CC0. Attribution: "© Overture Maps Foundation" in the app's credits.
"""
import argparse, os, sys, time, urllib.request, xml.etree.ElementTree as ET

import duckdb

BUCKET = 'overturemaps-us-west-2'
# Greater SEQ, Gold Coast to Sunshine Coast and Toowoomba (a little wider than the API's SEQ_BBOX)
MIN_LON, MAX_LON, MIN_LAT, MAX_LAT = 151.8, 153.7, -28.5, -25.9
MIN_CONFIDENCE = 0.7
MIN_ROWS = 100_000        # the 2026-10 release gives about 142k; far fewer means a broken extract
SKIP_CATEGORIES = ('home_service',)


def latest_release():
    url = f'https://{BUCKET}.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/'
    xml = urllib.request.urlopen(url, timeout=30).read()
    ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}
    releases = [p.text.split('/')[1] for p in ET.fromstring(xml).findall('.//s3:CommonPrefixes/s3:Prefix', ns)]
    return sorted(releases)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--release', help='Overture release, e.g. 2026-10-21.0 (default: the latest)')
    ap.add_argument('--dry-run', action='store_true', help='load and check places_new, leave places alone')
    args = ap.parse_args()
    pg_url = os.environ.get('POSTGRES_URL_NON_POOLING') or os.environ.get('POSTGRES_URL')
    if not pg_url:
        sys.exit('POSTGRES_URL_NON_POOLING is not set')
    release = args.release or latest_release()
    t0 = time.time()
    print(f'Overture release {release}')

    db = duckdb.connect()
    db.execute("INSTALL httpfs; LOAD httpfs; INSTALL postgres; LOAD postgres; SET s3_region='us-west-2';")
    skip = ', '.join(f"'{c}'" for c in SKIP_CATEGORIES)
    db.execute(f"""
        CREATE TABLE seq AS
        SELECT id, name, category, address, locality, lat, lon, confidence FROM (
            SELECT id,
                   trim(names.primary) AS name,
                   basic_category AS category,
                   nullif(trim(addresses[1].freeform), '') AS address,
                   nullif(trim(addresses[1].locality), '') AS locality,
                   (bbox.ymin + bbox.ymax) / 2 AS lat,
                   (bbox.xmin + bbox.xmax) / 2 AS lon,
                   confidence,
                   -- one place listed twice (two sources, or a branch and its car park name)
                   row_number() OVER (PARTITION BY lower(trim(names.primary)),
                                      round((bbox.ymin + bbox.ymax) / 2, 3), round((bbox.xmin + bbox.xmax) / 2, 3)
                                      ORDER BY confidence DESC, id) AS n
            FROM read_parquet('s3://{BUCKET}/release/{release}/theme=places/type=place/*', hive_partitioning = 1)
            WHERE bbox.xmin BETWEEN {MIN_LON} AND {MAX_LON} AND bbox.ymin BETWEEN {MIN_LAT} AND {MAX_LAT}
              AND confidence >= {MIN_CONFIDENCE}
              AND coalesce(operating_status, 'open') = 'open'
              AND coalesce(basic_category, '') NOT IN ({skip})
              AND length(trim(names.primary)) >= 2
              -- no street address: often placed at a suburb's or city's centre, kilometres out
              AND nullif(trim(addresses[1].freeform), '') IS NOT NULL
        ) WHERE n = 1
    """)
    n = db.execute('SELECT count(*) FROM seq').fetchone()[0]
    print(f'{n:,} places in SEQ ({time.time() - t0:.0f}s)')
    if n < MIN_ROWS:
        sys.exit(f'Only {n:,} places (expected at least {MIN_ROWS:,}): leaving places alone')

    db.execute("ATTACH '" + pg_url.replace("'", "''") + "' AS pg (TYPE postgres)")
    ex = lambda sql: db.execute('CALL postgres_execute(?, ?)', ['pg', sql])
    ex('DROP TABLE IF EXISTS places_new')
    ex("""CREATE TABLE places_new (
            id text PRIMARY KEY, name text NOT NULL, category text, address text, locality text,
            lat double precision NOT NULL, lon double precision NOT NULL, confidence real NOT NULL)""")
    db.execute('INSERT INTO pg.public.places_new SELECT * FROM seq')
    print(f'Loaded ({time.time() - t0:.0f}s); indexing')
    # Trigram index for "words like these" matching on the name (pg_trgm's <% operator)
    ex('CREATE INDEX places_new_name_trgm ON places_new USING gin (name gin_trgm_ops)')
    ex('ANALYZE places_new')
    loaded = db.execute('SELECT * FROM postgres_query(?, ?)', ['pg', 'SELECT count(*) FROM places_new']).fetchone()[0]
    if loaded != n:
        sys.exit(f'places_new has {loaded:,} rows, expected {n:,}: leaving places alone')
    found = db.execute('SELECT * FROM postgres_query(?, ?)', ['pg',
        "SELECT count(*) FROM places_new WHERE name ILIKE 'Suncorp Stadium'"]).fetchone()[0]
    if not found:
        sys.exit('No "Suncorp Stadium" in places_new: leaving places alone')

    if args.dry_run:
        ex('DROP TABLE places_new')
        print('Dry run: checks passed; dropped places_new, places untouched.')
        return
    ex("""BEGIN;
          DROP TABLE IF EXISTS places;
          ALTER TABLE places_new RENAME TO places;
          ALTER INDEX places_new_name_trgm RENAME TO places_name_trgm;
          ALTER INDEX places_new_pkey RENAME TO places_pkey;
          COMMIT;""")
    print(f'Done: {n:,} places live in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
