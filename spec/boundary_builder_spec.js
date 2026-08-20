const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const geohash = require('../src/geohash');

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

const DOMINANT_COUNTY_PARENT_HASH = 's000';

function rectangleRing(minLon, minLat, maxLon, maxLat) {
  return [[
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat]
  ]];
}

function polygonFeature(id, name, placetype, population, ring) {
  const properties = {
    name,
    placetype,
    country_id: 'US',
    admin1_id: 36,
    is_current: 1
  };

  if (population !== null) {
    properties.population = population;
  }

  return {
    type: 'Feature',
    id,
    properties,
    geometry: { type: 'Polygon', coordinates: ring }
  };
}

// Covers the whole parent cell, so it owns that cell outright and stands in as
// the fallback label the rollup competes against.
function regionFeature(id, name, bbox) {
  return polygonFeature(id, name, 'region', null, rectangleRing(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat));
}

// A town sitting inside one child cell, inset so that it never touches a
// neighbouring cell: a polygon that shares an edge with the next cell claims
// that cell too, which would put both towns in competition for the same cells.
function childCellFeature(id, name, placetype, population, childHash) {
  const cell = geohash.decodeBbox(childHash);
  const insetLon = (cell.maxLon - cell.minLon) / 4;
  const insetLat = (cell.maxLat - cell.minLat) / 4;

  return polygonFeature(id, name, placetype, population, rectangleRing(
    cell.minLon + insetLon,
    cell.minLat + insetLat,
    cell.maxLon - insetLon,
    cell.maxLat - insetLat
  ));
}

function descendantCountSql(parentHash, placeId) {
  return `SELECT COUNT(*) AS count FROM compact_geohash_lookup WHERE geohash LIKE '${parentHash}%' AND geohash <> '${parentHash}' AND place_id = ${placeId}`;
}

// The Rochester shape: a county that outpopulates every town inside it, two
// small towns that each own their own child cells, and a region as fallback.
function writeDominantCountyFixture(inputPath) {
  const bbox = geohash.decodeBbox(DOMINANT_COUNTY_PARENT_HASH);
  const height = bbox.maxLat - bbox.minLat;
  const children = geohash.children(DOMINANT_COUNTY_PARENT_HASH);

  fs.writeFileSync(inputPath, JSON.stringify({
    type: 'FeatureCollection',
    features: [
      regionFeature(8001, 'Fallback Region', bbox),
      // Stops short of the cell's northern edge, the way a real county
      // boundary does, so it owns the child cells and not the parent itself.
      polygonFeature(8002, 'Monroe County', 'county', 748482,
        rectangleRing(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat - (height / 100))),
      childCellFeature(8003, 'Brockport', 'locality', 8366, children[0]),
      childCellFeature(8004, 'Greece', 'locality', 14519, children[20])
    ]
  }));

  return inputPath;
}

describe('boundary builder', () => {
  it('drops contained localities when pruning is enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'localities.geojson');
      const dbPath = path.join(dir, 'boundary.sqlite');

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 2001,
            properties: {
              name: 'Outer City',
              placetype: 'locality',
              country_id: 'US',
              admin1_id: 5,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
            }
          },
          {
            type: 'Feature',
            id: 2002,
            properties: {
              name: 'Inner Duplicate',
              placetype: 'locality',
              country_id: 'US',
              admin1_id: 5,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--base-precision', '4',
        '--max-precision', '5',
        '--index-mode', 'compact',
        '--drop-contained-localities', 'true'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const rows = await all(db, 'SELECT id, name FROM compact_places ORDER BY id ASC');
        expect(rows).toEqual([{ id: 2001, name: 'Outer City' }]);

        const lookupRows = await all(db, 'SELECT geohash, place_id FROM compact_geohash_lookup');
        expect(lookupRows.length).toBeGreaterThan(0);

        const legacyRows = await all(db, "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='place_geometry'");
        expect(legacyRows[0].count).toEqual(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls small localities up to region boundaries when configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'rollup.geojson');
      const dbPath = path.join(dir, 'rollup.sqlite');

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 3001,
            properties: {
              name: 'Wide Region',
              placetype: 'region',
              country_id: 'US',
              admin1_id: 5,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
            }
          },
          {
            type: 'Feature',
            id: 3002,
            properties: {
              name: 'Small Village',
              placetype: 'locality',
              country_id: 'US',
              admin1_id: 5,
              population: 1200,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--min-population', '5000',
        '--base-precision', '4',
        '--max-precision', '5'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const rows = await all(db, 'SELECT id, name, placetype_code FROM compact_places ORDER BY id ASC');
        expect(rows).toEqual([{ id: 3001, name: 'Wide Region', placetype_code: 2 }]);

        const lookupRows = await all(db, 'SELECT count(*) AS count FROM compact_geohash_lookup');
        expect(lookupRows[0].count).toBeGreaterThan(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps point capitals as locality cells even below min population', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'point-capital.geojson');
      const dbPath = path.join(dir, 'point-capital.sqlite');

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 4001,
            properties: {
              name: 'Fallback Region',
              placetype: 'region',
              country_id: 'GF',
              admin1_id: 85671195,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-53.2, 4.8], [-52.2, 4.8], [-52.2, 5.2], [-53.2, 5.2], [-53.2, 4.8]]]
            }
          },
          {
            type: 'Feature',
            id: 4002,
            properties: {
              name: 'Cayenne',
              placetype: 'locality',
              country_id: 'GF',
              admin1_id: 85671195,
              population: 600,
              'gn:feature_code': 'PPLC',
              is_current: 1
            },
            geometry: {
              type: 'Point',
              coordinates: [-52.33333, 4.93333]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--min-population', '5000',
        '--base-precision', '4',
        '--max-precision', '5'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const places = await all(db, 'SELECT id, name, placetype_code FROM compact_places ORDER BY id ASC');
        expect(places).toEqual([
          { id: 4001, name: 'Fallback Region', placetype_code: 2 },
          { id: 4002, name: 'Cayenne', placetype_code: 0 }
        ]);

        const capitalRows = await all(db, 'SELECT geohash FROM compact_geohash_lookup WHERE place_id = 4002');
        expect(capitalRows.length).toEqual(1);
        expect(capitalRows[0].geohash.length).toBeGreaterThanOrEqual(4);
        expect(capitalRows[0].geohash.length).toBeLessThanOrEqual(5);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes locality over region when there is no competing locality in the same parent cell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'locality-region-promotion.geojson');
      const dbPath = path.join(dir, 'locality-region-promotion.sqlite');
      const parentHash = 's000';
      const parentBbox = geohash.decodeBbox(parentHash);
      const midLon = (parentBbox.minLon + parentBbox.maxLon) / 2;

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 5001,
            properties: {
              name: 'Wide Region',
              placetype: 'region',
              country_id: 'AR',
              admin1_id: 1,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 5002,
            properties: {
              name: 'Metro City',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 1000000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [midLon, parentBbox.minLat],
                [midLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--promote-locality-over-region', 'true'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${parentHash}'`);
        expect(parentRow).toEqual([{ geohash: parentHash, place_id: 5002 }]);

        const regionDescendants = await all(
          db,
          `SELECT COUNT(*) AS count FROM compact_geohash_lookup WHERE geohash LIKE '${parentHash}%' AND geohash <> '${parentHash}' AND place_id = 5001`
        );
        expect(regionDescendants[0].count).toEqual(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not promote locality to parent cell when locality child-share is below threshold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'locality-region-share-threshold.geojson');
      const dbPath = path.join(dir, 'locality-region-share-threshold.sqlite');
      const parentHash = 's000';
      const parentBbox = geohash.decodeBbox(parentHash);
      const splitLon = parentBbox.minLon + ((parentBbox.maxLon - parentBbox.minLon) * 0.25);

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 5101,
            properties: {
              name: 'Wide Region',
              placetype: 'region',
              country_id: 'AR',
              admin1_id: 1,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 5102,
            properties: {
              name: 'Small Town',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 40000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [splitLon, parentBbox.minLat],
                [splitLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--parent-locality-min-share', '0.5'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${parentHash}'`);
        expect(parentRow).toEqual([{ geohash: parentHash, place_id: 5101 }]);

        const localityDescendants = await all(
          db,
          `SELECT COUNT(*) AS count FROM compact_geohash_lookup WHERE geohash LIKE '${parentHash}%' AND geohash <> '${parentHash}' AND place_id = 5102`
        );
        expect(localityDescendants[0].count).toBeGreaterThan(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls parent cells to a dominant major locality and suppresses minor locality descendants', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'dominant-locality.geojson');
      const dbPath = path.join(dir, 'dominant-locality.sqlite');
      const parentHash = 's000';
      const parentBbox = geohash.decodeBbox(parentHash);
      const splitLon = parentBbox.minLon + ((parentBbox.maxLon - parentBbox.minLon) * 0.75);

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 6001,
            properties: {
              name: 'Fallback Region',
              placetype: 'region',
              country_id: 'AR',
              admin1_id: 1,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 6002,
            properties: {
              name: 'Metro Core',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 1200000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [splitLon, parentBbox.minLat],
                [splitLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 6003,
            properties: {
              name: 'Outer Hamlet',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 18000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [splitLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [splitLon, parentBbox.maxLat],
                [splitLon, parentBbox.minLat]
              ]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--dominant-locality-population', '100000',
        '--dominant-locality-ratio', '3'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${parentHash}'`);
        expect(parentRow).toEqual([{ geohash: parentHash, place_id: 6002 }]);

        const minorDescendants = await all(
          db,
          `SELECT COUNT(*) AS count FROM compact_geohash_lookup WHERE geohash LIKE '${parentHash}%' AND geohash <> '${parentHash}' AND place_id = 6003`
        );
        expect(minorDescendants[0].count).toEqual(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps fine locality borders when multiple major localities compete', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'major-competition.geojson');
      const dbPath = path.join(dir, 'major-competition.sqlite');
      const parentHash = 's000';
      const parentBbox = geohash.decodeBbox(parentHash);
      const midLon = (parentBbox.minLon + parentBbox.maxLon) / 2;

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 7001,
            properties: {
              name: 'Fallback Region',
              placetype: 'region',
              country_id: 'AR',
              admin1_id: 1,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 7002,
            properties: {
              name: 'West Major City',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 1000000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [parentBbox.minLon, parentBbox.minLat],
                [midLon, parentBbox.minLat],
                [midLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.maxLat],
                [parentBbox.minLon, parentBbox.minLat]
              ]]
            }
          },
          {
            type: 'Feature',
            id: 7003,
            properties: {
              name: 'East Major City',
              placetype: 'locality',
              country_id: 'AR',
              admin1_id: 1,
              population: 850000,
              is_current: 1
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [midLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.minLat],
                [parentBbox.maxLon, parentBbox.maxLat],
                [midLon, parentBbox.maxLat],
                [midLon, parentBbox.minLat]
              ]]
            }
          }
        ]
      }));

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--dominant-locality-population', '100000',
        '--dominant-locality-ratio', '3'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const majorRows = await all(
          db,
          `SELECT place_id, COUNT(*) AS count
           FROM compact_geohash_lookup
           WHERE geohash LIKE '${parentHash}%' AND place_id IN (7002, 7003)
           GROUP BY place_id
           ORDER BY place_id`
        );
        expect(majorRows).toEqual([
          { place_id: 7002, count: jasmine.any(Number) },
          { place_id: 7003, count: jasmine.any(Number) }
        ]);
        expect(majorRows[0].count).toBeGreaterThan(0);
        expect(majorRows[1].count).toBeGreaterThan(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not roll a parent cell up to a dominant county', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'dominant-county.geojson');
      const dbPath = path.join(dir, 'dominant-county.sqlite');

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', writeDominantCountyFixture(inputPath),
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--include-county', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--dominant-locality-population', '100000',
        '--dominant-locality-ratio', '3'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        // The county outranks every town on population, so it must not carry
        // the parent cell -- and the runner-up town must not inherit the
        // rollup either, because it lost the same competition.
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${DOMINANT_COUNTY_PARENT_HASH}'`);
        expect(parentRow).toEqual([{ geohash: DOMINANT_COUNTY_PARENT_HASH, place_id: 8001 }]);

        const smallTownCells = await all(db, descendantCountSql(DOMINANT_COUNTY_PARENT_HASH, 8003));
        expect(smallTownCells[0].count).toBeGreaterThan(0);

        const largerTownCells = await all(db, descendantCountSql(DOMINANT_COUNTY_PARENT_HASH, 8004));
        expect(largerTownCells[0].count).toBeGreaterThan(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls a parent cell up to a dominant county when county is opted back in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'dominant-county-opt-in.geojson');
      const dbPath = path.join(dir, 'dominant-county-opt-in.sqlite');

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', writeDominantCountyFixture(inputPath),
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--include-county', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--dominant-locality-population', '100000',
        '--dominant-locality-ratio', '3',
        '--dominant-city-placetypes', 'locality,localadmin,county'
      ], { encoding: 'utf8' });

      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${DOMINANT_COUNTY_PARENT_HASH}'`);
        expect(parentRow).toEqual([{ geohash: DOMINANT_COUNTY_PARENT_HASH, place_id: 8002 }]);

        const smallTownCells = await all(db, descendantCountSql(DOMINANT_COUNTY_PARENT_HASH, 8003));
        expect(smallTownCells[0].count).toEqual(0);

        const largerTownCells = await all(db, descendantCountSql(DOMINANT_COUNTY_PARENT_HASH, 8004));
        expect(largerTownCells[0].count).toEqual(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still rolls a parent cell up to a dominant city when a county owns cells beside it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'dominant-city-with-county.geojson');
      const parentHash = 's000';
      const parentBbox = geohash.decodeBbox(parentHash);
      const width = parentBbox.maxLon - parentBbox.minLon;
      const height = parentBbox.maxLat - parentBbox.minLat;
      // The eastern quarter of the parent cell is left to the hamlet, the
      // county and the region; the metro takes everything west of it.
      const metroMaxLon = parentBbox.minLon + (width * 0.75) - (width / 1000);
      const eastern = geohash.children(parentHash)
        .filter((child) => geohash.decodeBbox(child).minLon > metroMaxLon);

      fs.writeFileSync(inputPath, JSON.stringify({
        type: 'FeatureCollection',
        features: [
          regionFeature(9001, 'Fallback Region', parentBbox),
          // Sprawls over the parent cell without filling it, so it owns child
          // cells rather than the parent cell itself.
          polygonFeature(9002, 'Metro Core', 'locality', 1200000,
            rectangleRing(parentBbox.minLon, parentBbox.minLat, metroMaxLon, parentBbox.maxLat - (height / 100))),
          childCellFeature(9003, 'Rural Hamlet', 'locality', 18000, eastern[0]),
          childCellFeature(9004, 'Rural County', 'county', 30000, eastern[eastern.length - 1])
        ]
      }));

      const build = (dbPath, dominantPopulation) => spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', inputPath,
        '--index-mode', 'compact',
        '--include-region', 'true',
        '--include-county', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--dominant-locality-population', dominantPopulation,
        '--dominant-locality-ratio', '3'
      ], { encoding: 'utf8' });

      // With the rollup out of reach, the hamlet and the county each hold a
      // child cell of their own: the rollup below has something to fold in.
      const withoutRollupPath = path.join(dir, 'without-rollup.sqlite');
      expect(build(withoutRollupPath, '5000000').status).toEqual(0);

      const withoutRollup = new sqlite3.Database(withoutRollupPath);
      try {
        const hamletCells = await all(withoutRollup, descendantCountSql(parentHash, 9003));
        expect(hamletCells[0].count).toBeGreaterThan(0);

        const countyCells = await all(withoutRollup, descendantCountSql(parentHash, 9004));
        expect(countyCells[0].count).toBeGreaterThan(0);
      } finally {
        await close(withoutRollup);
      }

      const dbPath = path.join(dir, 'dominant-city-with-county.sqlite');
      expect(build(dbPath, '100000').status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const parentRow = await all(db, `SELECT geohash, place_id FROM compact_geohash_lookup WHERE geohash='${parentHash}'`);
        expect(parentRow).toEqual([{ geohash: parentHash, place_id: 9002 }]);

        const hamletCells = await all(db, descendantCountSql(parentHash, 9003));
        expect(hamletCells[0].count).toEqual(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects a dominant-city placetype that cannot own a city label', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-builder-'));
    try {
      const inputPath = path.join(dir, 'dominant-city-placetypes.geojson');
      const dbPath = path.join(dir, 'dominant-city-placetypes.sqlite');

      const result = spawnSync('node', [
        path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
        '--database', dbPath,
        '--input', writeDominantCountyFixture(inputPath),
        '--index-mode', 'compact',
        '--dominant-city-placetypes', 'locality,region'
      ], { encoding: 'utf8' });

      expect(result.status).not.toEqual(0);
      expect(result.stderr).toContain('--dominant-city-placetypes only accepts city-like placetypes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
