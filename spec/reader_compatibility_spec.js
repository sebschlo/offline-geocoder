// Reader/database compatibility contract — see COMPATIBILITY.md.
//
// Shipped database files and reader code can be paired across versions in
// both directions, so the reader must keep working against every schema
// generation that ever shipped. Each describe block below builds a fixture
// database with the FROZEN schema of one generation (tables and columns as
// they shipped — deliberately not derived from scripts/schema.sql or the
// builder, which move forward over time) and asserts the reader paths that
// generation supports.
//
// Rules:
// - Never modify the block of a generation that has shipped. If a new
//   schema generation ships, add a new block (and a row to
//   COMPATIBILITY.md) instead.
// - Fixtures omit performance indexes: they don't affect reader-visible
//   behavior. Tables and columns are exact.
// - The boundary-generation fixtures deliberately omit the GeoNames base
//   tables (`features`, `coordinates`, the `everything` view), so if the
//   boundary path ever falls through to the legacy centroid fallback the
//   spec fails loudly ("no such table: everything") instead of silently
//   passing. The centroid-only generation consists of exactly those base
//   tables and pins the centroid paths directly.
// - Lookup test points are cross-mapped: the geohash cell maps to one
//   place while another place's centroid is nearer, so a broken geohash
//   lookup cannot sneak through via the nearest-centroid fallback.
// - Stored geohash keys are frozen literals, never computed here. See
//   FROZEN_GEOHASH below.
// - Each generation pins its exact column set, and generated databases
//   are checked to remain supersets of it. See FROZEN_COLUMNS below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const createGeocoder = require('../src/index.js');
const geohash = require('../src/geohash');

// Frozen precision-5 geohash lookup keys, stored as literals.
//
// These must NOT be computed with src/geohash: the reader queries with
// that same encoder, so computing both sides would make the fixtures
// self-referential — an incompatible encoder change would regenerate the
// stored keys and the query keys together, leaving every spec green while
// real databases persisted by older builders became unreadable.
//
// The encoder conformance block below pins these literals (alongside
// published reference vectors from the geohash specification), so an
// encoder change fails immediately and names the drifted coordinate
// instead of surfacing as a mysterious lookup miss.
const FROZEN_GEOHASH = {
  '40.5,10.95': 'sppy3',
  '40.5,11.85': 'sr0qm',
  '-20.65,130.65': 'qukft',
  '-20.3,130.3': 'qukst',
  '47.6,-3.2': 'gbmwz',
  '47.3,-3.7': 'gbmm5'
};

// Frozen column signatures, in declaration order, for every generation.
//
// Each entry is `name TYPE [NOT NULL] [DEFAULT x] [PK]` — the fields of
// PRAGMA table_info that are part of the compatibility contract:
//
// - `name` and `type` are asserted everywhere. Affinity is reader-visible:
//   flipping `latitude REAL` to TEXT hands arithmetic a string.
// - `NOT NULL`, `DEFAULT` and `PK` are asserted on fixtures (frozen
//   history, nothing legitimately changes them) but NOT on generated
//   databases, where only name+type are required. That is deliberate:
//   relaxing a shipped NOT NULL column is reader-visible (a value readers
//   always had can arrive null), while tightening one only constrains
//   builders — and the current scripts/schema.sql legitimately tightened
//   `features.name` / `features.country_id` to NOT NULL relative to the
//   v1.0.0 schema without breaking any reader.
// - `cid` (ordinal position) is deliberately excluded: the contract
//   requires readers to select by name, so column order is not binding.
//   These lists are written in declaration order purely for legibility.
//
// Two jobs: each fixture asserts its own tables match EXACTLY (so a
// fixture cannot be quietly widened to make a new reader pass), and the
// generated-database block at the bottom asserts freshly built databases
// are a SUPERSET of the shipped sets (so a builder that drops, renames or
// retypes a shipped column fails here, even while the current reader still
// happens to support both layouts).
const FROZEN_COLUMNS = {
  // Generation 0 as v1.0.0 actually declared it: no NOT NULL anywhere.
  // scripts/schema.sql has since tightened several of these columns, which
  // is why the generated-database check compares name+type only.
  centroid: {
    coordinates: ['feature_id INTEGER PK', 'latitude REAL', 'longitude REAL'],
    features: ['id INTEGER PK', 'name TEXT', 'country_id TEXT', 'admin1_id INTEGER'],
    admin1: ['country_id TEXT PK', 'id INTEGER PK', 'name TEXT'],
    countries: ['id TEXT PK', 'name TEXT']
  },
  full: {
    countries: ['id TEXT PK', 'name TEXT NOT NULL'],
    admin1: ['country_id TEXT NOT NULL PK', 'id INTEGER NOT NULL PK', 'name TEXT NOT NULL'],
    places: [
      'id INTEGER PK', 'name TEXT NOT NULL', 'country_id TEXT NOT NULL',
      'admin1_id INTEGER', 'placetype TEXT NOT NULL',
      'centroid_lat REAL NOT NULL', 'centroid_lon REAL NOT NULL',
      'bbox_min_lat REAL NOT NULL', 'bbox_min_lon REAL NOT NULL',
      'bbox_max_lat REAL NOT NULL', 'bbox_max_lon REAL NOT NULL',
      'priority_rank INTEGER NOT NULL DEFAULT 0', 'area REAL NOT NULL DEFAULT 0',
      'country_name TEXT', 'admin1_name TEXT'
    ],
    place_geohash_cover: [
      'geohash TEXT NOT NULL PK', 'precision INTEGER NOT NULL PK',
      'place_id INTEGER NOT NULL PK', 'coverage_type TEXT NOT NULL'
    ],
    place_geometry: [
      'place_id INTEGER PK', "encoding TEXT NOT NULL DEFAULT 'json'",
      'geometry BLOB NOT NULL'
    ],
    place_geohash_lookup: ['geohash TEXT PK', 'place_id INTEGER NOT NULL']
  },
  compactLegacy: {
    countries: ['id TEXT PK', 'name TEXT NOT NULL'],
    admin1: ['country_id TEXT NOT NULL PK', 'id INTEGER NOT NULL PK', 'name TEXT NOT NULL'],
    places: [
      'id INTEGER PK', 'name TEXT NOT NULL', 'country_id TEXT NOT NULL',
      'admin1_id INTEGER', 'placetype TEXT NOT NULL',
      'centroid_lat REAL NOT NULL', 'centroid_lon REAL NOT NULL',
      'bbox_min_lat REAL NOT NULL', 'bbox_min_lon REAL NOT NULL',
      'bbox_max_lat REAL NOT NULL', 'bbox_max_lon REAL NOT NULL',
      'priority_rank INTEGER NOT NULL DEFAULT 0', 'area REAL NOT NULL DEFAULT 0',
      'country_name TEXT', 'admin1_name TEXT'
    ],
    place_geohash_lookup: ['geohash TEXT PK', 'place_id INTEGER NOT NULL']
  },
  compactV2: {
    compact_places: [
      'id INTEGER PK', 'name TEXT NOT NULL', 'country_id TEXT NOT NULL',
      'admin1_id INTEGER', 'placetype_code INTEGER NOT NULL',
      'latitude REAL NOT NULL', 'longitude REAL NOT NULL'
    ],
    compact_geohash_lookup: ['geohash TEXT PK', 'place_id INTEGER NOT NULL']
  },
  compactV2Population: {
    compact_places: [
      'id INTEGER PK', 'name TEXT NOT NULL', 'country_id TEXT NOT NULL',
      'admin1_id INTEGER', 'placetype_code INTEGER NOT NULL',
      'latitude REAL NOT NULL', 'longitude REAL NOT NULL',
      'population REAL', 'area REAL'
    ],
    compact_geohash_lookup: ['geohash TEXT PK', 'place_id INTEGER NOT NULL']
  }
};

// Output columns of the `everything` view as generation 0 exposed them.
// Readers select from this view and read fields by name, so its output
// column set is contract surface even though no table declares it.
//
// Names only: a view's reported column affinity is derived from the
// underlying expression and varies with the SQLite version, so pinning
// types here would test the host, not the schema.
const FROZEN_EVERYTHING_COLUMNS = [
  'id', 'name', 'admin1_id', 'admin1_name',
  'country_id', 'country_name', 'latitude', 'longitude'
];

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

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

// Renders one PRAGMA table_info row in the frozen-signature format.
function formatSignature(row, typeOnly) {
  let signature = `${row.name} ${row.type}`;
  if (typeOnly) {
    return signature;
  }
  if (row.notnull) signature += ' NOT NULL';
  if (row.dflt_value !== null && row.dflt_value !== undefined) {
    signature += ` DEFAULT ${row.dflt_value}`;
  }
  if (row.pk) signature += ' PK';
  return signature;
}

// Reads column signatures in declaration order via PRAGMA table_info.
// typeOnly drops the fields that generated databases may legitimately
// tighten (see FROZEN_COLUMNS).
async function readSignatures(databasePath, table, typeOnly) {
  const db = new sqlite3.Database(databasePath);
  try {
    const rows = await all(db, `PRAGMA table_info(${table})`);
    return rows.map((row) => formatSignature(row, typeOnly));
  } finally {
    await close(db);
  }
}

// Registers the exact-signature assertion for one generation's fixture.
function expectFrozenColumns(getDatabasePath, frozen) {
  it('preserves the exact frozen column signatures of this generation', async () => {
    for (const table of Object.keys(frozen)) {
      const actual = await readSignatures(getDatabasePath(), table, false);
      // Compared as strings so a failure names the table and both lists.
      expect(`${table}: ${actual.join(', ')}`)
        .toEqual(`${table}: ${frozen[table].join(', ')}`);
    }
  });
}

// Asserts a generated database still carries every frozen column, by name
// and declared type. Extra columns pass; drops, renames and retypes fail.
async function expectSuperset(databasePath, frozen) {
  for (const table of Object.keys(frozen)) {
    const actual = await readSignatures(databasePath, table, true);
    const required = frozen[table].map((entry) => {
      const parts = entry.split(' ');
      return `${parts[0]} ${parts[1]}`;
    });
    const missing = required.filter((entry) => actual.indexOf(entry) === -1);
    // Compared as strings so a failure names the table and the columns.
    expect(`${table} missing: ${missing.join(', ')}`).toEqual(`${table} missing: `);
  }
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

// The encoder is the one piece of reader logic that must agree with bytes
// written by builders that ran months or years ago. Pin it against
// published geohash reference vectors and against every literal key the
// fixtures below store.
describe('reader compatibility: geohash encoder conformance', () => {
  it('matches published geohash reference vectors', () => {
    expect(geohash.encode(42.6, -5.6, 5)).toEqual('ezs42');
    expect(geohash.encode(57.64911, 10.40744, 11)).toEqual('u4pruydqqvj');
    expect(geohash.encode(0, 0, 5)).toEqual('s0000');
  });

  it('still produces the frozen lookup keys stored in shipped databases', () => {
    for (const coordinate of Object.keys(FROZEN_GEOHASH)) {
      const parts = coordinate.split(',');
      const encoded = geohash.encode(Number(parts[0]), Number(parts[1]), 5);
      expect(`${coordinate} -> ${encoded}`)
        .toEqual(`${coordinate} -> ${FROZEN_GEOHASH[coordinate]}`);
    }
  });
});

// Generation 0: GeoNames centroid-only schema, as generated by the
// released v1.0.0 code (scripts/generate_geonames.sh at tag time).
//
// Tables: features (four columns — no asciiname, no population),
// coordinates, countries, admin1, and the everything view. No boundary
// tables at all. Pins four pairings that must keep working:
// centroid-mode reverse, boundary-mode reverse falling through to the
// centroid path, id lookup, and forward geocoding returning undefined
// because the columns it needs are absent.
describe('reader compatibility: centroid-only schema generation (v1.0.0)', () => {
  let fixture;
  let centroidGeocoder;
  let boundaryModeGeocoder;

  const schema = `
    CREATE TABLE coordinates(
      feature_id INTEGER,
      latitude REAL,
      longitude REAL,
      PRIMARY KEY (feature_id)
    );

    CREATE TABLE features(
      id INTEGER,
      name TEXT,
      country_id TEXT,
      admin1_id INTEGER,
      PRIMARY KEY (id)
    );

    CREATE TABLE admin1(
      country_id TEXT,
      id INTEGER,
      name TEXT,
      PRIMARY KEY (country_id, id)
    );

    CREATE TABLE countries(
      id TEXT,
      name TEXT,
      PRIMARY KEY (id)
    );

    CREATE VIEW everything AS
      SELECT
        features.id,
        features.name,
        admin1.id AS admin1_id,
        admin1.name AS admin1_name,
        countries.id AS country_id,
        countries.name AS country_name,
        coordinates.latitude AS latitude,
        coordinates.longitude AS longitude
      FROM features
        LEFT JOIN countries ON features.country_id = countries.id
        LEFT JOIN admin1 ON features.country_id = admin1.country_id AND features.admin1_id = admin1.id
        JOIN coordinates ON features.id = coordinates.feature_id;
  `;

  beforeAll(async () => {
    fixture = createTempDatabase('centroid-v1');
    const db = fixture.db;

    await exec(db, schema);
    await exec(db, `
      INSERT INTO countries(id, name) VALUES ('XD', 'Vetusia');
      INSERT INTO admin1(country_id, id, name) VALUES ('XD', 4, 'Old March');
      INSERT INTO features(id, name, country_id, admin1_id) VALUES
        (701, 'Oldbridge', 'XD', 4),
        (702, 'Newford', 'XD', 4);
      INSERT INTO coordinates(feature_id, latitude, longitude) VALUES
        (701, 10.25, 55.25),
        (702, 10.75, 55.75);
    `);
    await close(db);

    centroidGeocoder = createGeocoder({ database: fixture.databasePath });
    boundaryModeGeocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('resolves centroid-mode reverse lookups', async () => {
    const result = await centroidGeocoder.reverse(10.3, 55.3);
    expect(result.id).toEqual(701);
    expect(result.name).toEqual('Oldbridge');
    expect(result.formatted).toEqual('Oldbridge, Old March, Vetusia');
    expect(result.country).toEqual({ id: 'XD', name: 'Vetusia' });
    expect(result.admin1).toEqual({ id: 4, name: 'Old March' });
  });

  it('falls through to the centroid path when a boundary-mode reader opens it', async () => {
    const result = await boundaryModeGeocoder.reverse(10.7, 55.7);
    expect(result.id).toEqual(702);
    expect(result.name).toEqual('Newford');
    expect(result.formatted).toEqual('Newford, Old March, Vetusia');
  });

  it('resolves id lookups', async () => {
    const result = await centroidGeocoder.location.find(701);
    expect(result.id).toEqual(701);
    expect(result.name).toEqual('Oldbridge');
  });

  it('degrades forward geocoding to undefined instead of erroring', async () => {
    const result = await centroidGeocoder.forward('Oldbridge');
    expect(result).toBeUndefined();
  });

  expectFrozenColumns(() => fixture.databasePath, FROZEN_COLUMNS.centroid);
});

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

    // Two adjacent 1x1 degree localities. Harborview's test point
    // (40.5, 10.95) sits inside its polygon but nearer to Milltown's
    // centroid, so only the polygon path can answer it correctly.
    //
    // Notchford is a decoy that makes polygon containment itself
    // load-bearing: it shares the test point's cover cell, its bbox
    // contains the point, its centroid is by far the nearest, and its
    // small area would win the contained-places tie-break — but its
    // C-shaped polygon has a notch that excludes the point. If geometry
    // loading or point-in-polygon regresses (returning nothing, or
    // matching everything), Notchford wins and the spec fails.
    const places = [
      {
        id: 501, name: 'Harborview', centroidLat: 40.5, centroidLon: 10.5,
        polygon: { type: 'Polygon', coordinates: [[[10, 40], [11, 40], [11, 41], [10, 41], [10, 40]]] },
        bbox: { minLat: 40, minLon: 10, maxLat: 41, maxLon: 11 },
        priorityRank: 10, area: 1.0,
        coverCells: [FROZEN_GEOHASH['40.5,10.95']]
      },
      {
        id: 502, name: 'Milltown', centroidLat: 40.5, centroidLon: 11.05,
        polygon: { type: 'Polygon', coordinates: [[[11, 40], [12, 40], [12, 41], [11, 41], [11, 40]]] },
        bbox: { minLat: 40, minLon: 11, maxLat: 41, maxLon: 12 },
        priorityRank: 20, area: 1.0,
        coverCells: [FROZEN_GEOHASH['40.5,11.85']]
      },
      {
        id: 503, name: 'Notchford', centroidLat: 40.46, centroidLon: 10.95,
        // Covers the 10.90..11.00 x 40.45..40.55 rectangle except an
        // east-opening notch (lon 10.93..11.00, lat 40.48..40.52) that
        // contains the test point (40.5, 10.95).
        polygon: {
          type: 'Polygon',
          coordinates: [[
            [10.90, 40.45], [11.00, 40.45], [11.00, 40.48], [10.93, 40.48],
            [10.93, 40.52], [11.00, 40.52], [11.00, 40.55], [10.90, 40.55],
            [10.90, 40.45]
          ]]
        },
        bbox: { minLat: 40.45, minLon: 10.90, maxLat: 40.55, maxLon: 11.00 },
        priorityRank: 5, area: 0.01,
        coverCells: [FROZEN_GEOHASH['40.5,10.95']]
      }
    ];

    for (const place of places) {
      await run(db, `
        INSERT INTO places(
          id, name, country_id, admin1_id, placetype,
          centroid_lat, centroid_lon,
          bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
          priority_rank, area, country_name, admin1_name
        ) VALUES (?, ?, 'XA', 7, 'locality', ?, ?, ?, ?, ?, ?, ?, ?, 'Atlantis', 'Coral Province')
      `, [
        place.id, place.name, place.centroidLat, place.centroidLon,
        place.bbox.minLat, place.bbox.minLon, place.bbox.maxLat, place.bbox.maxLon,
        place.priorityRank, place.area
      ]);

      await run(db, `
        INSERT INTO place_geometry(place_id, encoding, geometry) VALUES (?, 'json', ?)
      `, [place.id, JSON.stringify(place.polygon)]);

      // Cover cells at precision 5, as the builder of this generation
      // persisted them (frozen literals, not recomputed here).
      for (const cell of place.coverCells) {
        await run(db, `
          INSERT INTO place_geohash_cover(geohash, precision, place_id, coverage_type)
          VALUES (?, 5, ?, 'partial')
        `, [cell, place.id]);
      }
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

  expectFrozenColumns(() => fixture.databasePath, FROZEN_COLUMNS.full);
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

    // Cross-mapped lookup cells (frozen literals): each test point's cell
    // maps to the place whose centroid is FARTHER away.
    await run(db, 'INSERT INTO place_geohash_lookup(geohash, place_id) VALUES (?, ?)',
      [FROZEN_GEOHASH['-20.65,130.65'], 611]);
    await run(db, 'INSERT INTO place_geohash_lookup(geohash, place_id) VALUES (?, ?)',
      [FROZEN_GEOHASH['-20.3,130.3'], 612]);

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

  expectFrozenColumns(() => fixture.databasePath, FROZEN_COLUMNS.compactLegacy);
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
  // Cross-mapped lookup cells (frozen literals): each test point's cell
  // maps to the place whose centroid is FARTHER away, so a broken lookup
  // that degrades to the nearest-centroid fallback returns the wrong place
  // and fails the spec.
  lookups: [
    { geohash: FROZEN_GEOHASH['47.6,-3.2'], placeId: 81 },
    { geohash: FROZEN_GEOHASH['47.3,-3.7'], placeId: 82 }
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
        [lookup.geohash, lookup.placeId]);
    }

    await close(db);
    geocoder = boundaryGeocoder(fixture.databasePath);
  });

  afterAll(() => {
    fixture.cleanup();
  });

  expectCompactV2Results(() => geocoder);
  expectFrozenColumns(() => fixture.databasePath, FROZEN_COLUMNS.compactV2);
});

// Generation 4: compact v2 schema with nullable population/area columns,
// added by the append/merge work (#3), which upgrades older databases in
// place with ALTER TABLE ... ADD COLUMN.
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
        [lookup.geohash, lookup.placeId]);
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
  expectFrozenColumns(() => fixture.databasePath, FROZEN_COLUMNS.compactV2Population);
});

// The opposite direction of the contract: an older reader opening a NEWLY
// generated database. The fixtures above cannot see that regression —
// they only run the current reader against hand-written historical
// databases, so a builder that drops or renames a shipped column stays
// green as long as the current reader still supports both layouts.
//
// Instead of vendoring copies of released readers (which would rot, and
// whose git history is unavailable under CI's shallow checkout), assert
// the structural property those readers depend on: every database the
// builder produces today must remain a SUPERSET of the frozen column set
// of every generation that mode has shipped. Additive columns pass;
// removals and renames fail.
describe('reader compatibility: generated databases stay supersets of shipped generations', () => {
  const BUILDER = path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js');

  // One locality is enough — this asserts schema, not place selection.
  const INPUT = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: 3001,
      properties: {
        name: 'Buildertown',
        placetype: 'locality',
        country_id: 'US',
        admin1_id: 5,
        is_current: 1
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
      }
    }]
  };

  function build(indexMode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `offline-geocoder-compat-build-${indexMode}-`));
    const inputPath = path.join(dir, 'input.geojson');
    const databasePath = path.join(dir, 'built.sqlite');

    fs.writeFileSync(inputPath, JSON.stringify(INPUT));

    const result = spawnSync('node', [
      BUILDER,
      '--database', databasePath,
      '--input', inputPath,
      '--base-precision', '4',
      '--max-precision', '5',
      '--index-mode', indexMode
    ], { encoding: 'utf8' });

    return {
      status: result.status,
      stderr: result.stderr,
      databasePath: databasePath,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
  }

  it('keeps every shipped compact v2 column in --index-mode compact', async () => {
    const built = build('compact');
    try {
      expect(`exit ${built.status}: ${built.stderr}`).toEqual('exit 0: ');
      // Generation 3 first: those seven columns are what readers shipped
      // before population/area existed, and they must survive every
      // future widening of this table.
      await expectSuperset(built.databasePath, FROZEN_COLUMNS.compactV2);
      await expectSuperset(built.databasePath, FROZEN_COLUMNS.compactV2Population);
    } finally {
      built.cleanup();
    }
  }, 30000);

  it('keeps every shipped full and compact-legacy column in --index-mode full', async () => {
    const built = build('full');
    try {
      expect(`exit ${built.status}: ${built.stderr}`).toEqual('exit 0: ');
      await expectSuperset(built.databasePath, FROZEN_COLUMNS.full);
      await expectSuperset(built.databasePath, FROZEN_COLUMNS.compactLegacy);
    } finally {
      built.cleanup();
    }
  }, 30000);

  // The GeoNames base schema has its own generator: scripts/schema.sql,
  // applied verbatim by scripts/generate_geonames.sh. Without this case a
  // dropped or renamed generation-0 column — or a narrowed `everything`
  // view — would ship while every fixture above stayed green, because the
  // fixtures hand-write their own historical DDL.
  describe('GeoNames base schema (scripts/schema.sql)', () => {
    let fixture;

    beforeAll(async () => {
      fixture = createTempDatabase('schema-sql');
      const schemaSql = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8');
      await exec(fixture.db, schemaSql);
      await close(fixture.db);
    });

    afterAll(() => {
      fixture.cleanup();
    });

    it('keeps every generation-0 table column', async () => {
      await expectSuperset(fixture.databasePath, FROZEN_COLUMNS.centroid);
    });

    it('keeps every generation-0 output column of the everything view', async () => {
      const actual = await readSignatures(fixture.databasePath, 'everything', true);
      const names = actual.map((entry) => entry.split(' ')[0]);
      const missing = FROZEN_EVERYTHING_COLUMNS.filter(
        (column) => names.indexOf(column) === -1);
      expect(`everything missing: ${missing.join(', ')}`).toEqual('everything missing: ');
    });
  });
});
