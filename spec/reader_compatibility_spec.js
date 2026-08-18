// Reader/database compatibility contract — see COMPATIBILITY.md.
//
// Shipped database files and reader code can be paired across versions in
// both directions, so the reader must keep working against every schema
// generation that ever shipped. Each describe block below builds a fixture
// database with the FROZEN schema of one generation (tables and columns as
// they shipped — deliberately not derived from scripts/schema.sql or the
// builder, which move forward over time) and asserts that reverse lookups
// in boundary mode still resolve correctly.
//
// Rules:
// - Never modify an existing generation block. If a new schema generation
//   ships, add a new block (and a row to COMPATIBILITY.md) instead.
// - Fixtures omit performance indexes: they don't affect reader-visible
//   behavior. Tables and columns are exact.
// - Fixtures deliberately omit the GeoNames base tables (`features`,
//   `coordinates`, the `everything` view), so if the boundary path ever
//   falls through to the legacy centroid fallback the spec fails loudly
//   ("no such table: everything") instead of silently passing.
// - Lookup test points are cross-mapped: the geohash cell maps to one
//   place while another place's centroid is nearer, so a broken geohash
//   lookup cannot sneak through via the nearest-centroid fallback.
// - Geohash keys are computed with the library's own encoder, exactly as
//   the database builder computes them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const createGeocoder = require('../src/index.js');
const geohash = require('../src/geohash');

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], (err) => (err ? reject(err) : resolve()));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function createTempDatabase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `offline-geocoder-compat-${name}-`));
  const databasePath = path.join(dir, 'fixture.sqlite');
  return {
    db: new sqlite3.Database(databasePath),
    databasePath: databasePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function boundaryGeocoder(databasePath) {
  return createGeocoder({
    database: databasePath,
    reverseMode: 'boundary',
    boundary: {
      basePrecision: 4,
      maxPrecision: 7
    }
  });
}

// Generation 1: full boundary schema.
//
// Tables: places + place_geohash_cover + place_geometry (+ countries,
// admin1, and an empty place_geohash_lookup, all created by the full-mode
// builder of that era). The empty lookup table is faithful to real full
// builds and additionally pins the runtime chain: the compact-legacy
// lookup runs first, misses, and hands over to the polygon path.
describe('reader compatibility: full boundary schema generation', () => {
  let fixture;
  let geocoder;

  const schema = `
    CREATE TABLE countries(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE admin1(
      country_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (country_id, id)
    );

    CREATE TABLE places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      country_id TEXT NOT NULL,
      admin1_id INTEGER,
      placetype TEXT NOT NULL,
      centroid_lat REAL NOT NULL,
      centroid_lon REAL NOT NULL,
      bbox_min_lat REAL NOT NULL,
      bbox_min_lon REAL NOT NULL,
      bbox_max_lat REAL NOT NULL,
      bbox_max_lon REAL NOT NULL,
      priority_rank INTEGER NOT NULL DEFAULT 0,
      area REAL NOT NULL DEFAULT 0,
      country_name TEXT,
      admin1_name TEXT
    );

    CREATE TABLE place_geohash_cover(
      geohash TEXT NOT NULL,
      precision INTEGER NOT NULL,
      place_id INTEGER NOT NULL,
      coverage_type TEXT NOT NULL CHECK (coverage_type IN ('full', 'partial')),
      PRIMARY KEY (geohash, precision, place_id),
      FOREIGN KEY (place_id) REFERENCES places(id)
    );

    CREATE TABLE place_geometry(
      place_id INTEGER PRIMARY KEY,
      encoding TEXT NOT NULL DEFAULT 'json',
      geometry BLOB NOT NULL,
      FOREIGN KEY (place_id) REFERENCES places(id)
    );

    CREATE TABLE place_geohash_lookup(
      geohash TEXT PRIMARY KEY,
      place_id INTEGER NOT NULL,
      FOREIGN KEY (place_id) REFERENCES places(id)
    );
  `;

  beforeAll(async () => {
    fixture = createTempDatabase('full');
    const db = fixture.db;

    await exec(db, schema);
    await exec(db, `
      INSERT INTO countries(id, name) VALUES ('XA', 'Atlantis');
      INSERT INTO admin1(country_id, id, name) VALUES ('XA', 7, 'Coral Province');
    `);

    // Two adjacent 1x1 degree localities. Harborview's test point sits
    // inside its polygon but nearer to Milltown's centroid, so only the
    // polygon path can answer it correctly.
    const places = [
      {
        id: 501, name: 'Harborview', centroidLat: 40.5, centroidLon: 10.5,
        polygon: { type: 'Polygon', coordinates: [[[10, 40], [11, 40], [11, 41], [10, 41], [10, 40]]] },
        bbox: { minLat: 40, minLon: 10, maxLat: 41, maxLon: 11 },
        priorityRank: 10, testPoint: { lat: 40.5, lon: 10.95 }
      },
      {
        id: 502, name: 'Milltown', centroidLat: 40.5, centroidLon: 11.05,
        polygon: { type: 'Polygon', coordinates: [[[11, 40], [12, 40], [12, 41], [11, 41], [11, 40]]] },
        bbox: { minLat: 40, minLon: 11, maxLat: 41, maxLon: 12 },
        priorityRank: 20, testPoint: { lat: 40.5, lon: 11.85 }
      }
    ];

    for (const place of places) {
      await run(db, `
        INSERT INTO places(
          id, name, country_id, admin1_id, placetype,
          centroid_lat, centroid_lon,
          bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
          priority_rank, area, country_name, admin1_name
        ) VALUES (?, ?, 'XA', 7, 'locality', ?, ?, ?, ?, ?, ?, ?, 1.0, 'Atlantis', 'Coral Province')
      `, [
        place.id, place.name, place.centroidLat, place.centroidLon,
        place.bbox.minLat, place.bbox.minLon, place.bbox.maxLat, place.bbox.maxLon,
        place.priorityRank
      ]);

      await run(db, `
        INSERT INTO place_geometry(place_id, encoding, geometry) VALUES (?, 'json', ?)
      `, [place.id, JSON.stringify(place.polygon)]);

      // Cover cell for the test point at precision 5, exactly as the
      // builder would emit for a cell intersecting the polygon.
      await run(db, `
        INSERT INTO place_geohash_cover(geohash, precision, place_id, coverage_type)
        VALUES (?, 5, ?, 'partial')
      `, [geohash.encode(place.testPoint.lat, place.testPoint.lon, 5), place.id]);
    }

    await close(db);
    geocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('resolves a point through polygon containment, not centroid distance', async () => {
    const result = await geocoder.reverse(40.5, 10.95);
    expect(result.id).toEqual(501);
    expect(result.name).toEqual('Harborview');
    expect(result.formatted).toEqual('Harborview, Coral Province, Atlantis');
    expect(result.country).toEqual({ id: 'XA', name: 'Atlantis' });
    expect(result.admin1).toEqual({ id: 7, name: 'Coral Province' });
  });

  it('resolves points in the neighbouring polygon to the neighbour', async () => {
    const result = await geocoder.reverse(40.5, 11.85);
    expect(result.id).toEqual(502);
    expect(result.name).toEqual('Milltown');
    expect(result.formatted).toEqual('Milltown, Coral Province, Atlantis');
  });
});

// Generation 2: compact legacy schema.
//
// Tables: places + place_geohash_lookup (+ countries and admin1, which the
// reader's legacy query joins against). No cover or geometry tables, so
// schema detection must choose the compact-legacy path.
describe('reader compatibility: compact legacy schema generation', () => {
  let fixture;
  let geocoder;

  const schema = `
    CREATE TABLE countries(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE admin1(
      country_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (country_id, id)
    );

    CREATE TABLE places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      country_id TEXT NOT NULL,
      admin1_id INTEGER,
      placetype TEXT NOT NULL,
      centroid_lat REAL NOT NULL,
      centroid_lon REAL NOT NULL,
      bbox_min_lat REAL NOT NULL,
      bbox_min_lon REAL NOT NULL,
      bbox_max_lat REAL NOT NULL,
      bbox_max_lon REAL NOT NULL,
      priority_rank INTEGER NOT NULL DEFAULT 0,
      area REAL NOT NULL DEFAULT 0,
      country_name TEXT,
      admin1_name TEXT
    );

    CREATE TABLE place_geohash_lookup(
      geohash TEXT PRIMARY KEY,
      place_id INTEGER NOT NULL,
      FOREIGN KEY (place_id) REFERENCES places(id)
    );
  `;

  beforeAll(async () => {
    fixture = createTempDatabase('compact-legacy');
    const db = fixture.db;

    await exec(db, schema);
    await exec(db, `
      INSERT INTO countries(id, name) VALUES ('XB', 'Bordonia');
      INSERT INTO admin1(country_id, id, name) VALUES ('XB', 3, 'Northmark');
    `);

    const places = [
      { id: 611, name: 'Eastport', centroidLat: -20.25, centroidLon: 130.25 },
      { id: 612, name: 'Westport', centroidLat: -20.70, centroidLon: 130.70 }
    ];

    for (const place of places) {
      await run(db, `
        INSERT INTO places(
          id, name, country_id, admin1_id, placetype,
          centroid_lat, centroid_lon,
          bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
          priority_rank, area, country_name, admin1_name
        ) VALUES (?, ?, 'XB', 3, 'locality', ?, ?, ?, ?, ?, ?, 10, 1.0, 'Bordonia', 'Northmark')
      `, [
        place.id, place.name, place.centroidLat, place.centroidLon,
        place.centroidLat - 0.4, place.centroidLon - 0.4,
        place.centroidLat + 0.4, place.centroidLon + 0.4
      ]);
    }

    // Cross-mapped lookup cells: each test point's cell maps to the place
    // whose centroid is FARTHER away.
    await run(db, 'INSERT INTO place_geohash_lookup(geohash, place_id) VALUES (?, ?)',
      [geohash.encode(-20.65, 130.65, 5), 611]);
    await run(db, 'INSERT INTO place_geohash_lookup(geohash, place_id) VALUES (?, ?)',
      [geohash.encode(-20.30, 130.30, 5), 612]);

    await close(db);
    geocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('resolves via the legacy geohash lookup table', async () => {
    const result = await geocoder.reverse(-20.65, 130.65);
    expect(result.id).toEqual(611);
    expect(result.name).toEqual('Eastport');
    expect(result.formatted).toEqual('Eastport, Northmark, Bordonia');
    expect(result.country).toEqual({ id: 'XB', name: 'Bordonia' });
    expect(result.admin1).toEqual({ id: 3, name: 'Northmark' });
  });

  it('resolves the cross-mapped counterpart cell', async () => {
    const result = await geocoder.reverse(-20.30, 130.30);
    expect(result.id).toEqual(612);
    expect(result.name).toEqual('Westport');
    expect(result.formatted).toEqual('Westport, Northmark, Bordonia');
  });
});

// Shared seed data for the two compact v2 generations. Both blocks insert
// the same logical places so their expected results are identical — that
// identity is the compatibility guarantee under test in generation 4.
const COMPACT_V2_ROWS = {
  region: { id: 71, name: 'Meridian Province', countryId: 'XC', placetypeCode: 2, lat: 47.5, lon: -3.5 },
  localities: [
    { id: 81, name: 'Alphaville', countryId: 'XC', admin1Id: 71, placetypeCode: 0, lat: 47.25, lon: -3.75 },
    { id: 82, name: 'Betaton', countryId: 'XC', admin1Id: 71, placetypeCode: 0, lat: 47.70, lon: -3.10 }
  ],
  // Cross-mapped lookup cells: each test point's cell maps to the place
  // whose centroid is FARTHER away, so a broken lookup that degrades to the
  // nearest-centroid fallback returns the wrong place and fails the spec.
  lookups: [
    { point: { lat: 47.60, lon: -3.20 }, placeId: 81 },
    { point: { lat: 47.30, lon: -3.70 }, placeId: 82 }
  ]
};

function expectCompactV2Results(getGeocoder) {
  it('resolves via the compact geohash lookup', async () => {
    const result = await getGeocoder().reverse(47.60, -3.20);
    expect(result.id).toEqual(81);
    expect(result.name).toEqual('Alphaville');
    // Compact v2 stores no country display name; the reader uses the
    // country id and resolves the admin1 name via a self-join on the
    // region row.
    expect(result.formatted).toEqual('Alphaville, Meridian Province, XC');
    expect(result.country).toEqual({ id: 'XC', name: 'XC' });
    expect(result.admin1).toEqual({ id: 71, name: 'Meridian Province' });
  });

  it('resolves the cross-mapped counterpart cell', async () => {
    const result = await getGeocoder().reverse(47.30, -3.70);
    expect(result.id).toEqual(82);
    expect(result.name).toEqual('Betaton');
    expect(result.formatted).toEqual('Betaton, Meridian Province, XC');
  });
}

// Generation 3: compact v2 schema, as shipped in bundled app databases.
//
// Tables: compact_places + compact_geohash_lookup only. compact_places has
// exactly seven columns — in particular NO population or area columns.
describe('reader compatibility: compact v2 schema generation (shipped)', () => {
  let fixture;
  let geocoder;

  const schema = `
    CREATE TABLE compact_places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      country_id TEXT NOT NULL,
      admin1_id INTEGER,
      placetype_code INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL
    );

    CREATE TABLE compact_geohash_lookup(
      geohash TEXT PRIMARY KEY,
      place_id INTEGER NOT NULL,
      FOREIGN KEY (place_id) REFERENCES compact_places(id)
    );
  `;

  beforeAll(async () => {
    fixture = createTempDatabase('compact-v2');
    const db = fixture.db;

    await exec(db, schema);

    const rows = [COMPACT_V2_ROWS.region].concat(COMPACT_V2_ROWS.localities);
    for (const row of rows) {
      await run(db, `
        INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [row.id, row.name, row.countryId, row.admin1Id || null, row.placetypeCode, row.lat, row.lon]);
    }

    for (const lookup of COMPACT_V2_ROWS.lookups) {
      await run(db, 'INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES (?, ?)',
        [geohash.encode(lookup.point.lat, lookup.point.lon, 5), lookup.placeId]);
    }

    await close(db);
    geocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  expectCompactV2Results(() => geocoder);
});

// Generation 4: compact v2 schema with nullable population/area columns
// (added by the append/merge work; older databases are upgraded in place
// with ALTER TABLE ... ADD COLUMN).
//
// Same tables as generation 3 plus two nullable REAL columns that the
// reader does not select. The fixture stores values on one locality and
// NULLs on the other, and the expected results are identical to
// generation 3 — extra builder-only columns must be invisible to readers.
describe('reader compatibility: compact v2 schema generation with population/area', () => {
  let fixture;
  let geocoder;

  const schema = `
    CREATE TABLE compact_places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      country_id TEXT NOT NULL,
      admin1_id INTEGER,
      placetype_code INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      population REAL,
      area REAL
    );

    CREATE TABLE compact_geohash_lookup(
      geohash TEXT PRIMARY KEY,
      place_id INTEGER NOT NULL,
      FOREIGN KEY (place_id) REFERENCES compact_places(id)
    );
  `;

  const populationById = {
    81: { population: 125000, area: 42.5 },
    82: { population: null, area: null }
  };

  beforeAll(async () => {
    fixture = createTempDatabase('compact-v2-population');
    const db = fixture.db;

    await exec(db, schema);

    const rows = [COMPACT_V2_ROWS.region].concat(COMPACT_V2_ROWS.localities);
    for (const row of rows) {
      const extras = populationById[row.id] || { population: null, area: null };
      await run(db, `
        INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude, population, area)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        row.id, row.name, row.countryId, row.admin1Id || null, row.placetypeCode,
        row.lat, row.lon, extras.population, extras.area
      ]);
    }

    for (const lookup of COMPACT_V2_ROWS.lookups) {
      await run(db, 'INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES (?, ?)',
        [geohash.encode(lookup.point.lat, lookup.point.lon, 5), lookup.placeId]);
    }

    await close(db);
    geocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  // Identical expectations to the shipped compact v2 generation: the new
  // columns (valued or NULL) must not change any reader-visible result.
  expectCompactV2Results(() => geocoder);
});
