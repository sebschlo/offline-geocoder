const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const geohash = require('../src/geohash');

function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function runBuilder(args) {
  return spawnSync('node', [
    path.join(__dirname, '..', 'scripts', 'generate_boundary_index.js')
  ].concat(args), { encoding: 'utf8' });
}

// A rectangular place with an explicit label centroid, so a fixture can put a
// town's centre anywhere inside its own polygon (real border towns sit at the
// edge of their country, not in the middle of their bounding box).
function place(spec) {
  return {
    type: 'Feature',
    id: spec.id,
    properties: {
      name: spec.name,
      placetype: spec.placetype,
      country_id: spec.countryId,
      admin1_id: 1,
      is_current: 1,
      population: spec.population,
      centroid_lat: spec.centroid[0],
      centroid_lon: spec.centroid[1]
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [spec.minLon, spec.minLat],
        [spec.maxLon, spec.minLat],
        [spec.maxLon, spec.maxLat],
        [spec.minLon, spec.maxLat],
        [spec.minLon, spec.minLat]
      ]]
    }
  };
}

function writeFixture(dir, name, features) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify({ type: 'FeatureCollection', features: features }));
  return filePath;
}

// Mirror the runtime lookup in src/reverse.js: the compact index is walked by
// longest matching prefix, because a cell is only stored when it disagrees
// with the coarser cell above it.
async function lookupOwner(dbPath, hash) {
  const prefixes = [];
  for (let length = hash.length; length >= 1; length--) {
    prefixes.push(hash.slice(0, length));
  }

  const db = new sqlite3.Database(dbPath);
  try {
    const rows = await all(db, `
      SELECT p.id AS id, p.name AS name, p.country_id AS country_id
      FROM compact_geohash_lookup l
      JOIN compact_places p ON p.id = l.place_id
      WHERE l.geohash IN (${prefixes.map(() => '?').join(',')})
      ORDER BY LENGTH(l.geohash) DESC, p.placetype_code ASC, p.id ASC
      LIMIT 1
    `, prefixes);
    return rows.length ? rows[0] : null;
  } finally {
    await close(db);
  }
}

describe('boundary builder home cell ownership', () => {
  // Two localities straddling a national border, sharing the cell s000q.
  // BIGVILLE is 18x more populous and covers the whole shared strip;
  // SMALLTOWN sits in the cell and is the only one centred there.
  const BIGVILLE = {
    id: 1001,
    name: 'Bigville',
    placetype: 'locality',
    countryId: 'MX',
    population: 690000,
    minLon: 0, minLat: 0, maxLon: 0.30, maxLat: 0.15,
    centroid: [0.07, 0.10]
  };
  const SMALLTOWN = {
    id: 2001,
    name: 'Smalltown',
    placetype: 'locality',
    countryId: 'US',
    population: 38000,
    minLon: 0.28, minLat: 0, maxLon: 0.60, maxLat: 0.15,
    centroid: [0.07, 0.29]
  };

  const homeHash = geohash.encode(SMALLTOWN.centroid[0], SMALLTOWN.centroid[1], 5);
  // Also inside the shared strip, but holds neither centroid.
  const sharedHash = geohash.encode(0.13, 0.29, 5);

  const commonFlags = ['--base-precision', '4', '--max-precision', '5', '--index-mode', 'compact'];

  function withTempDir(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-home-'));
    return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  it('gives a place the cell holding its own centroid over a larger neighbour', async () => {
    await withTempDir(async (dir) => {
      const input = writeFixture(dir, 'border.geojson', [place(BIGVILLE), place(SMALLTOWN)]);
      const dbPath = path.join(dir, 'border.sqlite');

      expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);

      const home = await lookupOwner(dbPath, homeHash);
      expect(home.id).toEqual(SMALLTOWN.id);
      expect(home.country_id).toEqual('US');

      // The rule claims only the home cell: the rest of the shared strip
      // still goes to the more populous place.
      expect((await lookupOwner(dbPath, sharedHash)).id).toEqual(BIGVILLE.id);
    });
  });

  it('falls back to population when the rule is disabled', async () => {
    await withTempDir(async (dir) => {
      const input = writeFixture(dir, 'border.geojson', [place(BIGVILLE), place(SMALLTOWN)]);
      const dbPath = path.join(dir, 'border.sqlite');

      expect(runBuilder([
        '--database', dbPath, '--input', input, '--home-cell-priority', 'false'
      ].concat(commonFlags)).status).toEqual(0);

      const home = await lookupOwner(dbPath, homeHash);
      expect(home.id).toEqual(BIGVILLE.id);
      expect(home.country_id).toEqual('MX');
    });
  });

  it('still folds a minor locality into a dominant city inside one country', async () => {
    await withTempDir(async (dir) => {
      // Same geometry, one country: the metro rollup is a deliberate labelling
      // choice ("this whole area reads as the big city") and stays untouched.
      const input = writeFixture(dir, 'metro.geojson', [
        place(BIGVILLE),
        place(Object.assign({}, SMALLTOWN, { countryId: 'MX' }))
      ]);
      const dbPath = path.join(dir, 'metro.sqlite');

      expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);
      expect((await lookupOwner(dbPath, homeHash)).id).toEqual(BIGVILLE.id);
    });
  });

  it('leaves cells shared by two centred places to the population ordering', async () => {
    await withTempDir(async (dir) => {
      // Both centroids now land in s000q, so neither claim is privileged.
      const input = writeFixture(dir, 'twins.geojson', [
        place(Object.assign({}, BIGVILLE, { centroid: [0.075, 0.292] })),
        place(Object.assign({}, SMALLTOWN, { centroid: [0.065, 0.288] }))
      ]);
      const dbPath = path.join(dir, 'twins.sqlite');

      expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);
      expect((await lookupOwner(dbPath, homeHash)).id).toEqual(BIGVILLE.id);
    });
  });

  it('keeps placetype rank ahead of the home cell claim', async () => {
    await withTempDir(async (dir) => {
      // The county is centred in s000q and the locality is not, but a county
      // label is a worse answer than a locality label for a point inside both.
      const input = writeFixture(dir, 'county.geojson', [
        place(BIGVILLE),
        place({
          id: 3001,
          name: 'Border County',
          placetype: 'county',
          countryId: 'US',
          population: 0,
          minLon: 0.28, minLat: 0, maxLon: 0.60, maxLat: 0.15,
          centroid: [0.07, 0.29]
        })
      ]);
      const dbPath = path.join(dir, 'county.sqlite');

      expect(runBuilder([
        '--database', dbPath, '--input', input, '--include-county', 'true'
      ].concat(commonFlags)).status).toEqual(0);

      expect((await lookupOwner(dbPath, homeHash)).id).toEqual(BIGVILLE.id);
    });
  });

  it('resolves the home cell the same way in either append order', async () => {
    await withTempDir(async (dir) => {
      const bigInput = writeFixture(dir, 'big.geojson', [place(BIGVILLE)]);
      const smallInput = writeFixture(dir, 'small.geojson', [place(SMALLTOWN)]);

      const bigFirstDb = path.join(dir, 'big-first.sqlite');
      const smallFirstDb = path.join(dir, 'small-first.sqlite');

      expect(runBuilder(['--database', bigFirstDb, '--input', bigInput].concat(commonFlags)).status).toEqual(0);
      expect(runBuilder(['--database', bigFirstDb, '--input', smallInput, '--append'].concat(commonFlags)).status).toEqual(0);

      expect(runBuilder(['--database', smallFirstDb, '--input', smallInput].concat(commonFlags)).status).toEqual(0);
      expect(runBuilder(['--database', smallFirstDb, '--input', bigInput, '--append'].concat(commonFlags)).status).toEqual(0);

      for (const dbPath of [bigFirstDb, smallFirstDb]) {
        expect((await lookupOwner(dbPath, homeHash)).id).toEqual(SMALLTOWN.id);
        expect((await lookupOwner(dbPath, sharedHash)).id).toEqual(BIGVILLE.id);
      }
    });
  });

  // The cases below turn on a place whose polygon swallows a whole
  // base-precision cell, so its cover terminates at precision 4 and the cell
  // holding its centre is a *coarse* one.  That is what puts it out of reach
  // of the two rules that only ever look at one exact hash: the rollup's
  // descendant sweep (which skips hashes no longer than the parent) and the
  // comparator (which only ranks places that emitted the same hash).
  describe('across nested cover cells', () => {
    // s000 spans lon 0..0.3515625, lat 0..0.17578125 and splits into 8x4
    // children at precision 5.
    const PARENT_HASH = 's000';

    // A rural town on the far side of the border. Its polygon contains all of
    // s000, so s000 is both its cover cell and its home cell.
    const HOMELAND = {
      id: 4001,
      name: 'Homeland',
      placetype: 'locality',
      countryId: 'US',
      population: 40000,
      minLon: -0.05, minLat: -0.05, maxLon: 0.40, maxLat: 0.22,
      centroid: [0.02, 0.02]
    };

    // The city across the border: seven times the population, covering the
    // eastern six of the eight child columns (24 of 32 cells).
    const METROPOLIS = {
      id: 4002,
      name: 'Metropolis',
      placetype: 'locality',
      countryId: 'MX',
      population: 690000,
      minLon: 0.088, minLat: -0.05, maxLon: 0.60, maxLat: 0.22,
      centroid: [0.07, 0.29]
    };

    // A small neighbour in the same country as Metropolis, present only so the
    // rollup takes its dominant-city branch instead of the single-locality one.
    const SUBURB = {
      id: 4003,
      name: 'Suburb',
      placetype: 'locality',
      countryId: 'MX',
      population: 20000,
      minLon: 0.045, minLat: 0.002, maxLon: 0.086, maxLat: 0.085,
      centroid: [0.04, 0.06]
    };

    const metropolisCell = geohash.encode(0.06, 0.285, 5);

    it('keeps a foreign home cell when the rollup promotes that very cell', async () => {
      await withTempDir(async (dir) => {
        // Homeland's centre sits in the one child column no Mexican place
        // covers, so nothing finer than s000 answers for it: if the promotion
        // takes s000, the town's own centre reads as Mexico.
        const input = writeFixture(dir, 'promote.geojson', [
          place(HOMELAND), place(METROPOLIS), place(SUBURB)
        ]);
        const dbPath = path.join(dir, 'promote.sqlite');

        expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);

        const homeCell = geohash.encode(HOMELAND.centroid[0], HOMELAND.centroid[1], 5);
        expect(homeCell.slice(0, PARENT_HASH.length)).toEqual(PARENT_HASH);

        const owner = await lookupOwner(dbPath, homeCell);
        expect(owner.id).toEqual(HOMELAND.id);
        expect(owner.country_id).toEqual('US');

        // The promotion is refused, not inverted: cells Metropolis covers
        // itself still answer with Metropolis.
        expect((await lookupOwner(dbPath, metropolisCell)).id).toEqual(METROPOLIS.id);
      });
    });

    it('keeps a coarse home cell against a finer cell emitted by a neighbour', async () => {
      await withTempDir(async (dir) => {
        // Same geometry, but Homeland's centre now sits in a child cell
        // Metropolis covers. Neither place emits the other's hash, so no
        // single-cell comparison ever ranks them and the runtime's
        // longest-prefix walk answers with the finer foreign row.
        const input = writeFixture(dir, 'nested.geojson', [
          place(Object.assign({}, HOMELAND, { centroid: [0.11, 0.11] })),
          place(METROPOLIS)
        ]);
        const dbPath = path.join(dir, 'nested.sqlite');

        expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);

        const homeCell = geohash.encode(0.11, 0.11, 5);
        expect(homeCell.length).toEqual(5);
        expect(homeCell.slice(0, PARENT_HASH.length)).toEqual(PARENT_HASH);

        const owner = await lookupOwner(dbPath, homeCell);
        expect(owner.id).toEqual(HOMELAND.id);
        expect(owner.country_id).toEqual('US');

        // Only the cell holding the centre changes hands.
        expect((await lookupOwner(dbPath, metropolisCell)).id).toEqual(METROPOLIS.id);
      });
    });

    it('leaves the nested cell alone when the rule is disabled', async () => {
      await withTempDir(async (dir) => {
        const input = writeFixture(dir, 'nested.geojson', [
          place(Object.assign({}, HOMELAND, { centroid: [0.11, 0.11] })),
          place(METROPOLIS)
        ]);
        const dbPath = path.join(dir, 'nested-off.sqlite');

        expect(runBuilder([
          '--database', dbPath, '--input', input, '--home-cell-priority', 'false'
        ].concat(commonFlags)).status).toEqual(0);

        expect((await lookupOwner(dbPath, geohash.encode(0.11, 0.11, 5))).id).toEqual(METROPOLIS.id);
      });
    });
  });
});
