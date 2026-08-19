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

const SMALL_COUNTY_ID = 8001;
const LARGE_COUNTY_ID = 8002;

// A municipality-sized county tucked inside a single precision-4 cell
// (bbox area well under 300 km2) plus a department-sized county spanning
// roughly 3x3 degrees (bbox area far above any dense threshold).
function writeCountiesFixture(inputPath) {
  const smallCell = geohash.decodeBbox('s000');
  const lonSpan = smallCell.maxLon - smallCell.minLon;
  const latSpan = smallCell.maxLat - smallCell.minLat;
  const smallMinLon = smallCell.minLon + (lonSpan * 0.15);
  const smallMaxLon = smallCell.minLon + (lonSpan * 0.45);
  const smallMinLat = smallCell.minLat + (latSpan * 0.15);
  const smallMaxLat = smallCell.minLat + (latSpan * 0.45);

  fs.writeFileSync(inputPath, JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: SMALL_COUNTY_ID,
        properties: {
          name: 'Tiny Municipality',
          placetype: 'county',
          country_id: 'GT',
          admin1_id: 1,
          population: 40000,
          is_current: 1
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [smallMinLon, smallMinLat],
            [smallMaxLon, smallMinLat],
            [smallMaxLon, smallMaxLat],
            [smallMinLon, smallMaxLat],
            [smallMinLon, smallMinLat]
          ]]
        }
      },
      {
        type: 'Feature',
        id: LARGE_COUNTY_ID,
        properties: {
          name: 'Wide County',
          placetype: 'county',
          country_id: 'US',
          admin1_id: 2,
          population: 900000,
          is_current: 1
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[20, 20], [23, 20], [23, 23], [20, 23], [20, 20]]]
        }
      }
    ]
  }));
}

function runBuilder(inputPath, dbPath, extraArgs) {
  return spawnSync('node', [
    path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js'),
    '--database', dbPath,
    '--input', inputPath,
    '--index-mode', 'compact',
    '--include-county', 'true',
    '--base-precision', '4',
    '--max-precision', '5'
  ].concat(extraArgs), { encoding: 'utf8' });
}

function lookupLengths(db, placeId) {
  return all(db, `SELECT DISTINCT length(geohash) AS len FROM compact_geohash_lookup WHERE place_id = ${placeId} ORDER BY len`);
}

describe('boundary builder dense county precision', () => {
  it('raises small counties under the area threshold to the dense precision', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-dense-county-'));
    try {
      const inputPath = path.join(dir, 'counties.geojson');
      const dbPath = path.join(dir, 'dense.sqlite');
      writeCountiesFixture(inputPath);

      const result = runBuilder(inputPath, dbPath, [
        '--county-max-precision', '4',
        '--county-dense-max-precision', '5',
        '--county-dense-max-area-km2', '300'
      ]);

      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('Dense county rule: area_km2<=300 => max_precision=5');

      const db = new sqlite3.Database(dbPath);
      try {
        const smallLengths = await lookupLengths(db, SMALL_COUNTY_ID);
        expect(smallLengths).toEqual([{ len: 5 }]);

        const largeLengths = await lookupLengths(db, LARGE_COUNTY_ID);
        expect(largeLengths).toEqual([{ len: 4 }]);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives a coarser county cap when only the dense flags are given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-dense-county-'));
    try {
      const inputPath = path.join(dir, 'counties.geojson');
      const dbPath = path.join(dir, 'derived.sqlite');
      writeCountiesFixture(inputPath);

      // No --county-max-precision: the cap must default to one below the
      // dense precision (4), not the global max, or the area threshold
      // would be a no-op.
      const result = runBuilder(inputPath, dbPath, [
        '--county-dense-max-precision', '5',
        '--county-dense-max-area-km2', '300'
      ]);

      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('county=4');

      const db = new sqlite3.Database(dbPath);
      try {
        const smallLengths = await lookupLengths(db, SMALL_COUNTY_ID);
        expect(smallLengths).toEqual([{ len: 5 }]);

        const largeLengths = await lookupLengths(db, LARGE_COUNTY_ID);
        expect(largeLengths).toEqual([{ len: 4 }]);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps counties at the county precision cap when the dense flags are absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-dense-county-'));
    try {
      const inputPath = path.join(dir, 'counties.geojson');
      const dbPath = path.join(dir, 'plain.sqlite');
      writeCountiesFixture(inputPath);

      const result = runBuilder(inputPath, dbPath, ['--county-max-precision', '4']);

      expect(result.status).toEqual(0);
      expect(result.stdout).not.toContain('Dense county rule');

      const db = new sqlite3.Database(dbPath);
      try {
        const smallLengths = await lookupLengths(db, SMALL_COUNTY_ID);
        expect(smallLengths).toEqual([{ len: 4 }]);

        const largeLengths = await lookupLengths(db, LARGE_COUNTY_ID);
        expect(largeLengths).toEqual([{ len: 4 }]);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
