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

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
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

function boxFeature(id, name, placetype, countryId, population, minLon, minLat, maxLon, maxLat) {
  return {
    type: 'Feature',
    id: id,
    properties: {
      name: name,
      placetype: placetype,
      country_id: countryId,
      admin1_id: 1,
      is_current: 1,
      population: population
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat]
      ]]
    }
  };
}

function writeFixture(dir, name, features) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify({ type: 'FeatureCollection', features: features }));
  return filePath;
}

async function lookupOwner(dbPath, hash) {
  const db = new sqlite3.Database(dbPath);
  try {
    const rows = await all(db, 'SELECT place_id FROM compact_geohash_lookup WHERE geohash = ?', [hash]);
    return rows.length ? rows[0].place_id : null;
  } finally {
    await close(db);
  }
}

async function createLegacyDatabase(dbPath, place, ownedHash) {
  const db = new sqlite3.Database(dbPath);
  try {
    await exec(db, `
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

      INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude)
      VALUES (${place.id}, '${place.name}', '${place.countryId}', 1, ${place.placetypeCode}, ${place.latitude}, ${place.longitude});

      INSERT INTO compact_geohash_lookup(geohash, place_id)
      VALUES ('${ownedHash}', ${place.id});
    `);
  } finally {
    await close(db);
  }
}

describe('boundary builder append merge', () => {
  // Two localities in different countries overlapping around lon 0.28..0.30:
  // "Bigville" should own the shared border cell no matter which country is
  // appended last.
  const BIGVILLE = { id: 1001, name: 'Bigville', population: 500000 };
  const SMALLTOWN = { id: 2001, name: 'Smalltown', population: 1000 };
  const contestedHash = geohash.encode(0.07, 0.29, 5);
  const bigOnlyHash = geohash.encode(0.07, 0.10, 5);
  const smallOnlyHash = geohash.encode(0.07, 0.50, 5);

  function buildInBothOrders(dir) {
    const bigInput = writeFixture(dir, 'big.geojson', [
      boxFeature(BIGVILLE.id, BIGVILLE.name, 'locality', 'AA', BIGVILLE.population, 0, 0, 0.30, 0.15)
    ]);
    const smallInput = writeFixture(dir, 'small.geojson', [
      boxFeature(SMALLTOWN.id, SMALLTOWN.name, 'locality', 'BB', SMALLTOWN.population, 0.28, 0, 0.60, 0.15)
    ]);

    const commonFlags = ['--base-precision', '4', '--max-precision', '5', '--index-mode', 'compact'];
    const bigFirstDb = path.join(dir, 'big-first.sqlite');
    const smallFirstDb = path.join(dir, 'small-first.sqlite');

    expect(runBuilder(['--database', bigFirstDb, '--input', bigInput].concat(commonFlags)).status).toEqual(0);
    expect(runBuilder(['--database', bigFirstDb, '--input', smallInput, '--append'].concat(commonFlags)).status).toEqual(0);

    expect(runBuilder(['--database', smallFirstDb, '--input', smallInput].concat(commonFlags)).status).toEqual(0);
    expect(runBuilder(['--database', smallFirstDb, '--input', bigInput, '--append'].concat(commonFlags)).status).toEqual(0);

    return { bigFirstDb, smallFirstDb };
  }

  it('resolves contested border cells by match quality regardless of append order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-merge-'));
    try {
      const { bigFirstDb, smallFirstDb } = buildInBothOrders(dir);

      expect(await lookupOwner(bigFirstDb, contestedHash)).toEqual(BIGVILLE.id);
      expect(await lookupOwner(smallFirstDb, contestedHash)).toEqual(BIGVILLE.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves uncontested cells with their only covering place in both orders', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-merge-'));
    try {
      const { bigFirstDb, smallFirstDb } = buildInBothOrders(dir);

      for (const dbPath of [bigFirstDb, smallFirstDb]) {
        expect(await lookupOwner(dbPath, bigOnlyHash)).toEqual(BIGVILLE.id);
        expect(await lookupOwner(dbPath, smallOnlyHash)).toEqual(SMALLTOWN.id);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades legacy databases in place and keeps better-ranked existing owners', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-merge-'));
    try {
      const dbPath = path.join(dir, 'legacy.sqlite');
      await createLegacyDatabase(dbPath, {
        id: 9001,
        name: 'Oldtown',
        countryId: 'AA',
        placetypeCode: 0,
        latitude: 0.066,
        longitude: 0.286
      }, contestedHash);

      const regionInput = writeFixture(dir, 'region.geojson', [
        boxFeature(3001, 'Wide Region', 'region', 'BB', 0, 0, 0, 0.60, 0.15)
      ]);

      const result = runBuilder([
        '--database', dbPath,
        '--input', regionInput,
        '--append',
        '--include-region', 'true',
        '--base-precision', '4',
        '--max-precision', '5',
        '--index-mode', 'compact'
      ]);

      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('Lookup rows deferring to better existing matches: 1');

      // The locality outranks the appended region on the contested cell even
      // though the legacy row has no population, and the region still claims
      // cells nobody owned.
      expect(await lookupOwner(dbPath, contestedHash)).toEqual(9001);
      expect(await lookupOwner(dbPath, smallOnlyHash)).toEqual(3001);

      const db = new sqlite3.Database(dbPath);
      try {
        const columns = await all(db, 'PRAGMA table_info(compact_places)');
        const names = columns.map((column) => column.name);
        expect(names).toContain('population');
        expect(names).toContain('area');

        const oldtown = await all(db, 'SELECT population FROM compact_places WHERE id = 9001');
        expect(oldtown[0].population).toBeNull();
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets an appended place with a higher population take a cell from a legacy row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-merge-'));
    try {
      const dbPath = path.join(dir, 'legacy.sqlite');
      // Oldtown owns the contested cell but is centred outside it, so the
      // population ordering is what decides this one.
      await createLegacyDatabase(dbPath, {
        id: 9001,
        name: 'Oldtown',
        countryId: 'AA',
        placetypeCode: 0,
        latitude: 0.066,
        longitude: 0.10
      }, contestedHash);

      const newvilleInput = writeFixture(dir, 'newville.geojson', [
        boxFeature(2101, 'Newville', 'locality', 'BB', 750000, 0.28, 0, 0.60, 0.15)
      ]);

      const result = runBuilder([
        '--database', dbPath,
        '--input', newvilleInput,
        '--append',
        '--base-precision', '4',
        '--max-precision', '5',
        '--index-mode', 'compact'
      ]);

      expect(result.status).toEqual(0);
      expect(await lookupOwner(dbPath, contestedHash)).toEqual(2101);

      const db = new sqlite3.Database(dbPath);
      try {
        const newville = await all(db, 'SELECT population, area FROM compact_places WHERE id = 2101');
        expect(newville[0].population).toEqual(750000);
        expect(newville[0].area).toBeGreaterThan(0);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a contested cell with the existing place that is centred in it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-merge-'));
    try {
      const dbPath = path.join(dir, 'legacy.sqlite');
      // Oldtown's centroid is inside the contested cell, so the appended city
      // takes the rest of the shared strip but not Oldtown's own cell.
      await createLegacyDatabase(dbPath, {
        id: 9001,
        name: 'Oldtown',
        countryId: 'AA',
        placetypeCode: 0,
        latitude: 0.066,
        longitude: 0.286
      }, contestedHash);

      const newvilleInput = writeFixture(dir, 'newville.geojson', [
        boxFeature(2101, 'Newville', 'locality', 'BB', 750000, 0.28, 0, 0.60, 0.15)
      ]);

      const result = runBuilder([
        '--database', dbPath,
        '--input', newvilleInput,
        '--append',
        '--base-precision', '4',
        '--max-precision', '5',
        '--index-mode', 'compact'
      ]);

      expect(result.status).toEqual(0);
      expect(await lookupOwner(dbPath, contestedHash)).toEqual(9001);
      expect(await lookupOwner(dbPath, smallOnlyHash)).toEqual(2101);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
