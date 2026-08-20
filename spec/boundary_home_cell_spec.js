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

  it('does not grant home priority to a fallback bbox midpoint outside the geometry', async () => {
    await withTempDir(async (dir) => {
      // The C-shaped place has no explicit centroid, so its fallback is the
      // bbox midpoint (0.1, 0.3), in the open notch rather than the polygon.
      // Its upper arm still intersects the same geohash cell as Notch Town;
      // treating that exterior fallback as a home point would let population
      // hand the town's real centre to the wrong country.
      const cShape = {
        type: 'Feature',
        id: 3001,
        properties: {
          name: 'C Province',
          placetype: 'locality',
          country_id: 'MX',
          admin1_id: 1,
          is_current: 1,
          population: 690000
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [0, 0], [0.6, 0], [0.6, 0.08], [0.25, 0.08],
            [0.25, 0.12], [0.6, 0.12], [0.6, 0.2], [0, 0.2], [0, 0]
          ]]
        }
      };
      const notchTown = place({
        id: 3002,
        name: 'Notch Town',
        placetype: 'locality',
        countryId: 'US',
        population: 38000,
        minLon: 0.27, minLat: 0.085, maxLon: 0.33, maxLat: 0.115,
        centroid: [0.1, 0.3]
      });

      const input = writeFixture(dir, 'exterior-fallback.geojson', [cShape, notchTown]);
      const dbPath = path.join(dir, 'exterior-fallback.sqlite');

      expect(runBuilder([
        '--database', dbPath, '--input', input, '--dominant-locality-population', '0'
      ].concat(commonFlags)).status).toEqual(0);

      const owner = await lookupOwner(dbPath, geohash.encode(0.1, 0.3, 5));
      expect(owner.id).toEqual(notchTown.id);
      expect(owner.country_id).toEqual('US');
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

  it('will not let a county rollup swallow a locality it outranks', async () => {
    await withTempDir(async (dir) => {
      // A county dominates its parent cell on population and would suppress
      // every minor place under it - including the locality whose centre is
      // there. That is a label downgrade the comparator would never make,
      // and in an append build it leaves the cell undefended: the next
      // country written takes it, and the town's centre crosses the border.
      const county = {
        id: 6001,
        name: 'Border County',
        placetype: 'county',
        countryId: 'US',
        population: 400000,
        minLon: 0.088, minLat: -0.05, maxLon: 0.60, maxLat: 0.22,
        centroid: [0.07, 0.29]
      };
      const town = {
        id: 6002,
        name: 'County Town',
        placetype: 'locality',
        countryId: 'US',
        population: 20000,
        minLon: 0.045, minLat: 0.002, maxLon: 0.086, maxLat: 0.085,
        centroid: [0.04, 0.06]
      };

      const input = writeFixture(dir, 'county-rollup.geojson', [place(county), place(town)]);
      const dbPath = path.join(dir, 'county-rollup.sqlite');

      expect(runBuilder([
        '--database', dbPath, '--input', input, '--include-county', 'true'
      ].concat(commonFlags)).status).toEqual(0);

      const owner = await lookupOwner(dbPath, geohash.encode(town.centroid[0], town.centroid[1], 5));
      expect(owner.id).toEqual(town.id);

      // The county still holds the cells it covers on its own.
      expect((await lookupOwner(dbPath, geohash.encode(0.06, 0.285, 5))).id).toEqual(county.id);
    });
  });

  it('will not let a rollup take the parent cell from a place it outranks', async () => {
    await withTempDir(async (dir) => {
      // Same downgrade one level up. The locality's cover terminates at the
      // parent, so it owns no descendant row for the sweep to protect - only a
      // rank check on the replacement itself keeps its centre out of the
      // localadmin. A localadmin is an eligible dominant placetype by default,
      // unlike a county, so this is the case the parent guard still answers.
      const town = {
        id: 6101,
        name: 'Parent Town',
        placetype: 'locality',
        countryId: 'US',
        population: 20000,
        minLon: -0.05, minLat: -0.05, maxLon: 0.40, maxLat: 0.22,
        centroid: [0.02, 0.02]
      };
      const municipality = {
        id: 6102,
        name: 'Wide Municipality',
        placetype: 'localadmin',
        countryId: 'US',
        population: 400000,
        minLon: 0.088, minLat: -0.05, maxLon: 0.60, maxLat: 0.22,
        centroid: [0.07, 0.29]
      };
      // Reaches below Parent Town's southern edge so the contained-locality
      // prune leaves it alone; it exists only to make the rollup pick a
      // dominant place rather than take its single-candidate branch.
      const suburb = {
        id: 6103,
        name: 'Second Town',
        placetype: 'locality',
        countryId: 'US',
        population: 10000,
        minLon: 0.045, minLat: -0.08, maxLon: 0.086, maxLat: 0.085,
        centroid: [0.04, 0.06]
      };

      const input = writeFixture(dir, 'parent-rank.geojson', [place(town), place(municipality), place(suburb)]);
      const dbPath = path.join(dir, 'parent-rank.sqlite');

      expect(runBuilder([
        '--database', dbPath, '--input', input, '--include-localadmin', 'true'
      ].concat(commonFlags)).status).toEqual(0);

      const owner = await lookupOwner(dbPath, geohash.encode(town.centroid[0], town.centroid[1], 5));
      expect(owner.id).toEqual(town.id);

      expect((await lookupOwner(dbPath, geohash.encode(0.06, 0.285, 5))).id).toEqual(municipality.id);
    });
  });

  it('keeps the home-cell claim of a place that lost that cell on population', async () => {
    await withTempDir(async (dir) => {
      // Two towns across a border both swallow the same coarse cell and are
      // both centred in it, so population decides who owns it. The loser still
      // covers the finer cells over its own centre, and still outranks a third
      // place that is not centred there - reading claimants off the cells a
      // place happens to have won drops that claim entirely.
      const winner = {
        id: 7001,
        name: 'Bigger Twin',
        placetype: 'locality',
        countryId: 'MX',
        population: 500000,
        minLon: -0.05, minLat: -0.05, maxLon: 0.40, maxLat: 0.22,
        centroid: [0.02, 0.02]
      };
      const loser = {
        id: 7002,
        name: 'Smaller Twin',
        placetype: 'locality',
        countryId: 'US',
        population: 300000,
        minLon: -0.06, minLat: -0.06, maxLon: 0.41, maxLat: 0.23,
        centroid: [0.11, 0.11]
      };
      const neighbour = {
        id: 7003,
        name: 'Third City',
        placetype: 'locality',
        countryId: 'MX',
        population: 690000,
        minLon: 0.088, minLat: -0.05, maxLon: 0.60, maxLat: 0.22,
        centroid: [0.07, 0.29]
      };

      const input = writeFixture(dir, 'twins.geojson', [place(winner), place(loser), place(neighbour)]);
      const dbPath = path.join(dir, 'twins.sqlite');

      expect(runBuilder(['--database', dbPath, '--input', input].concat(commonFlags)).status).toEqual(0);

      // The coarse cell goes to the more populous twin, as documented.
      expect((await lookupOwner(dbPath, geohash.encode(winner.centroid[0], winner.centroid[1], 5))).id)
        .toEqual(winner.id);

      // The loser still takes the finer cell holding its own centre.
      const owner = await lookupOwner(dbPath, geohash.encode(loser.centroid[0], loser.centroid[1], 5));
      expect(owner.id).toEqual(loser.id);
      expect(owner.country_id).toEqual('US');

      expect((await lookupOwner(dbPath, geohash.encode(0.06, 0.285, 5))).id).toEqual(neighbour.id);
    });
  });

  it('does not restore a home claim for a centroid outside its own geometry', async () => {
    await withTempDir(async (dir) => {
      // A place whose centroid falls outside its own shape gets no home cell:
      // normalization checks the point against the geometry. That decision has
      // to survive being written to the database, because an --append batch
      // rebuilds incumbents from their stored coordinates alone.
      const horseshoe = {
        type: 'Feature',
        id: 9001,
        properties: {
          // No centroid properties, so the builder falls back to the bounding
          // box midpoint - which lands in this shape's slot, outside it.
          name: 'Horseshoe',
          placetype: 'locality',
          country_id: 'US',
          admin1_id: 1,
          is_current: 1,
          population: 500000
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [0.00, 0.00], [0.40, 0.00], [0.40, 0.20], [0.21, 0.20],
            [0.21, 0.06], [0.19, 0.06], [0.19, 0.20], [0.00, 0.20], [0.00, 0.00]
          ]]
        }
      };
      // Sits in the slot and is genuinely centred there, in another country.
      const middletown = place({
        id: 9002,
        name: 'Middletown',
        placetype: 'locality',
        countryId: 'MX',
        population: 100000,
        minLon: 0.185, minLat: 0.07, maxLon: 0.215, maxLat: 0.13,
        centroid: [0.10, 0.20]
      });

      // The bbox midpoint's cell still clips both arms, so Horseshoe really
      // does emit it - the claim is only wrong about being *centred* there.
      const contested = geohash.encode(0.10, 0.20, 5);
      const dbPath = path.join(dir, 'concave.sqlite');

      expect(runBuilder([
        '--database', dbPath,
        '--input', writeFixture(dir, 'horseshoe.geojson', [horseshoe])
      ].concat(commonFlags)).status).toEqual(0);
      expect(runBuilder([
        '--database', dbPath,
        '--input', writeFixture(dir, 'middletown.geojson', [middletown]),
        '--append'
      ].concat(commonFlags)).status).toEqual(0);

      const owner = await lookupOwner(dbPath, contested);
      expect(owner.id).toEqual(9002);
      expect(owner.country_id).toEqual('MX');

      // The decision is stored, not re-derived from the coordinates.
      const db = new sqlite3.Database(dbPath);
      try {
        const rows = await all(db, 'SELECT id, centroid_inside FROM compact_places ORDER BY id');
        expect(rows.find((row) => row.id === 9001).centroid_inside).toEqual(0);
        expect(rows.find((row) => row.id === 9002).centroid_inside).toEqual(1);
      } finally {
        await close(db);
      }
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

  // Three precisions are needed to see these two: a claim has to be able to
  // lose one level and still matter at the next, which cannot happen when the
  // index only holds two. Base precision 3 gives the cells s00 > s000 > s0000.
  describe('with three levels of nesting', () => {
    const deepFlags = ['--base-precision', '3', '--max-precision', '5', '--index-mode', 'compact'];

    // Covers all of s00, so its cover terminates at precision 3.
    const PROVINCE_TOWN = {
      id: 5001,
      name: 'Province Town',
      placetype: 'locality',
      countryId: 'US',
      population: 100000,
      minLon: -0.05, minLat: -0.05, maxLon: 1.45, maxLat: 1.45,
      centroid: [0.02, 0.02]
    };

    // Covers all of s000, so its cover terminates at precision 4, one level
    // inside Province Town. Its centre is in s000 but not in s0000.
    const INNER_CITY = {
      id: 5002,
      name: 'Inner City',
      placetype: 'locality',
      countryId: 'MX',
      population: 500000,
      minLon: -0.02, minLat: -0.02, maxLon: 0.37, maxLat: 0.19,
      centroid: [0.11, 0.11]
    };

    // Clips the corner of s0000 from outside s00, so it emits that one cell at
    // precision 5 and is centred nowhere near it.
    const CORNER_TOWN = {
      id: 5003,
      name: 'Corner Town',
      placetype: 'locality',
      countryId: 'MX',
      population: 200000,
      minLon: -0.30, minLat: -0.30, maxLon: 0.02, maxLat: 0.02,
      centroid: [-0.15, -0.15]
    };

    it('keeps a reclaimed cell that a nearer owner shadows', async () => {
      await withTempDir(async (dir) => {
        // Province Town owns s00 and is centred in it, so it claims down the
        // chain: it loses s000 to the bigger Inner City on population but wins
        // s0000 from Corner Town, which is not centred there. That leaves
        // s00=Province Town, s000=Inner City, s0000=Province Town - and the
        // s0000 row only survives compaction if redundancy is judged against
        // the nearest kept ancestor rather than any matching prefix.
        const input = writeFixture(dir, 'shadow.geojson', [
          place(PROVINCE_TOWN), place(INNER_CITY), place(CORNER_TOWN)
        ]);
        const dbPath = path.join(dir, 'shadow.sqlite');

        expect(runBuilder(['--database', dbPath, '--input', input].concat(deepFlags)).status).toEqual(0);

        const owner = await lookupOwner(dbPath, geohash.encode(0.02, 0.02, 5));
        expect(owner.id).toEqual(PROVINCE_TOWN.id);
        expect(owner.country_id).toEqual('US');

        // Inner City still holds the level in between.
        expect((await lookupOwner(dbPath, geohash.encode(0.11, 0.11, 5))).id).toEqual(INNER_CITY.id);
      });
    });

    it('propagates a displaced place\'s claim in either read order', async () => {
      await withTempDir(async (dir) => {
        // Province Town takes s000 from Inner City here (it is the more
        // populous of the two), so Inner City's own claim on the cell holding
        // its centre has to survive losing the cell it was claiming from.
        const outer = Object.assign({}, PROVINCE_TOWN, { population: 900000 });
        const inner = Object.assign({}, INNER_CITY, { population: 300000 });
        const neighbour = {
          id: 5004,
          name: 'Neighbour City',
          placetype: 'locality',
          countryId: 'MX',
          population: 690000,
          minLon: 0.088, minLat: -0.05, maxLon: 0.60, maxLat: 0.22,
          centroid: [0.07, 0.29]
        };

        const orders = {
          'outer-first': [place(outer), place(inner), place(neighbour)],
          'inner-first': [place(neighbour), place(inner), place(outer)]
        };

        for (const [label, features] of Object.entries(orders)) {
          const input = writeFixture(dir, `order-${label}.geojson`, features);
          const dbPath = path.join(dir, `order-${label}.sqlite`);

          expect(runBuilder(['--database', dbPath, '--input', input].concat(deepFlags)).status).toEqual(0);

          const owner = await lookupOwner(dbPath, geohash.encode(inner.centroid[0], inner.centroid[1], 5));
          expect(`${label}:${owner.id}`).toEqual(`${label}:${inner.id}`);
        }
      });
    });
  });
});
