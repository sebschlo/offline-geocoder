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
});
