const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const geohash = require('../src/geohash');
const curation = require('../scripts/apply_curation.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'apply_curation.js');

const CITY = 8000001;
const EAST = 8000002;
const WEST = 8000003;
const BYSTANDER = 8000004;
const GHOST = 8000005;
const HOMONYM = 8000006;

const points = {
  city: { lat: 10.2, lon: 10.2 },
  east: { lat: 20.2, lon: 20.2 },
  west: { lat: 30.2, lon: 30.2 },
  bystander: { lat: -20.2, lon: -20.2 },
  ghost: { lat: 40.2, lon: 40.2 },
  homonym: { lat: -40.2, lon: -160.2 }
};

// Cells owned by each place: one precision-4 (coarse fallback) cell and, for
// the counties, one precision-5 (fine) cell containing the place's point.
const cells = {
  cityCoarse: geohash.encode(points.city.lat, points.city.lon, 4),
  eastFine: geohash.encode(points.east.lat, points.east.lon, 5),
  westFine: geohash.encode(points.west.lat, points.west.lon, 5),
  bystanderFine: geohash.encode(points.bystander.lat, points.bystander.lon, 5),
  homonymFine: geohash.encode(points.homonym.lat, points.homonym.lon, 5)
};
cells.eastCoarse = cells.eastFine.slice(0, 4);
cells.westCoarse = cells.westFine.slice(0, 4);
cells.bystanderCoarse = cells.bystanderFine.slice(0, 4);

// A point inside the coarse (precision-4) cell but outside the fine
// (precision-5) cell, so a reverse lookup there only matches the coarse row.
function probeAvoidingChild(parentHash, childHash) {
  const bbox = geohash.decodeBbox(parentHash);
  const latSpan = bbox.maxLat - bbox.minLat;
  const lonSpan = bbox.maxLon - bbox.minLon;
  const candidates = [
    { lat: bbox.minLat + latSpan * 0.03, lon: bbox.minLon + lonSpan * 0.03 },
    { lat: bbox.maxLat - latSpan * 0.03, lon: bbox.maxLon - lonSpan * 0.03 },
    { lat: bbox.minLat + latSpan * 0.03, lon: bbox.maxLon - lonSpan * 0.03 },
    { lat: bbox.maxLat - latSpan * 0.03, lon: bbox.minLon + lonSpan * 0.03 }
  ];

  for (let i = 0; i < candidates.length; i++) {
    if (geohash.encode(candidates[i].lat, candidates[i].lon, childHash.length) !== childHash) {
      return candidates[i];
    }
  }

  throw new Error('Could not find a probe point outside the child cell');
}

const coarseEastProbe = probeAvoidingChild(cells.eastCoarse, cells.eastFine);

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
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

async function seedCompactDb(dbPath) {
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

      INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude) VALUES
        (${CITY}, 'Big City', 'US', 5, 0, ${points.city.lat}, ${points.city.lon}),
        (${EAST}, 'East County', 'US', 5, 3, ${points.east.lat}, ${points.east.lon}),
        (${WEST}, 'West County', 'US', 5, 3, ${points.west.lat}, ${points.west.lon}),
        (${BYSTANDER}, 'Bystander County', 'US', 5, 3, ${points.bystander.lat}, ${points.bystander.lon}),
        (${GHOST}, 'Ghost Town', 'US', 5, 0, ${points.ghost.lat}, ${points.ghost.lon}),
        (${HOMONYM}, 'Ghost Town', 'CA', 9, 0, ${points.homonym.lat}, ${points.homonym.lon});

      INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES
        ('${cells.cityCoarse}', ${CITY}),
        ('${cells.eastCoarse}', ${EAST}),
        ('${cells.eastFine}', ${EAST}),
        ('${cells.westCoarse}', ${WEST}),
        ('${cells.westFine}', ${WEST}),
        ('${cells.bystanderCoarse}', ${BYSTANDER}),
        ('${cells.bystanderFine}', ${BYSTANDER}),
        ('${cells.homonymFine}', ${HOMONYM});
    `);
  } finally {
    await close(db);
  }
}

async function lookupSnapshot(dbPath) {
  const db = new sqlite3.Database(dbPath);
  try {
    return await all(db, 'SELECT geohash, place_id FROM compact_geohash_lookup ORDER BY geohash ASC');
  } finally {
    await close(db);
  }
}

function ownerOf(rows, hash) {
  const row = rows.find((candidate) => candidate.geohash === hash);
  return row ? row.place_id : undefined;
}

function baseDoc() {
  return {
    country: 'US',
    entries: [
      {
        op: 'merge',
        into: CITY,
        absorb: [EAST, WEST],
        minPrecision: 5,
        rationale: 'Synthetic metro: East County and West County function as part of Big City at street-level precision.',
        probes: [
          { lat: points.east.lat, lon: points.east.lon, expect: 'Big City', note: 'absorbed fine cell reads as the city' },
          { lat: coarseEastProbe.lat, lon: coarseEastProbe.lon, expect: 'East County', note: 'coarse fallback keeps its owner' },
          { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'Bystander County', note: 'guard: bystander untouched' }
        ]
      }
    ]
  };
}

// Minimal structurally-valid entry for conflict-validation tests, which fail
// before any probe runs.
function conflictEntry(into, absorb) {
  return {
    op: 'merge',
    into: into,
    absorb: absorb,
    minPrecision: 5,
    rationale: 'Synthetic entry for cross-entry conflict validation tests.',
    probes: [
      { lat: points.city.lat, lon: points.city.lon, expect: 'Big City' }
    ]
  };
}

function writeDoc(dir, name, doc) {
  const docPath = path.join(dir, name);
  fs.writeFileSync(docPath, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  return docPath;
}

function runCurate(args) {
  return spawnSync('node', [SCRIPT].concat(args), { encoding: 'utf8' });
}

describe('curation overlay (scripts/apply_curation.js)', () => {
  it('relabels absorbed cells at or above minPrecision to the merge target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('relabeled 2 cell(s)');

      const rows = await lookupSnapshot(dbPath);
      expect(ownerOf(rows, cells.eastFine)).toEqual(CITY);
      expect(ownerOf(rows, cells.westFine)).toEqual(CITY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps coarse cells below minPrecision with their original owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(0);

      const rows = await lookupSnapshot(dbPath);
      expect(ownerOf(rows, cells.eastCoarse)).toEqual(EAST);
      expect(ownerOf(rows, cells.westCoarse)).toEqual(WEST);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves places outside the entry untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(0);

      const rows = await lookupSnapshot(dbPath);
      expect(ownerOf(rows, cells.bystanderCoarse)).toEqual(BYSTANDER);
      expect(ownerOf(rows, cells.bystanderFine)).toEqual(BYSTANDER);
      expect(ownerOf(rows, cells.cityCoarse)).toEqual(CITY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps absorbed places in compact_places', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(0);

      const db = new sqlite3.Database(dbPath);
      try {
        const places = await all(db, `SELECT id FROM compact_places WHERE id IN (${EAST}, ${WEST}) ORDER BY id ASC`);
        expect(places).toEqual([{ id: EAST }, { id: WEST }]);
      } finally {
        await close(db);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second apply changes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const first = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(first.status).toEqual(0);
      const afterFirst = await lookupSnapshot(dbPath);

      const second = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(second.status).toEqual(0);
      expect(second.stdout).toContain('relabeled 0 cell(s)');

      const afterSecond = await lookupSnapshot(dbPath);
      expect(afterSecond).toEqual(afterFirst);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an entry referencing a place id missing from the database and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      const doc = baseDoc();
      doc.entries[0].absorb = [EAST, 9999999];
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('9999999');
      expect(result.stderr).toContain('not found in compact_places');

      const after = await lookupSnapshot(dbPath);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an entry whose merge target also appears in absorb and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      const doc = baseDoc();
      doc.entries[0].absorb = [CITY, EAST];
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('both "into" and an "absorb"');

      const after = await lookupSnapshot(dbPath);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed curation files with a clear message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);

      const brokenJson = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'broken.json', '{ this is not json')
      ]);
      expect(brokenJson.status).toEqual(1);
      expect(brokenJson.stderr).toContain('Failed to parse curation file');

      const badPrecision = baseDoc();
      badPrecision.entries[0].minPrecision = 'five';
      const badPrecisionResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'bad-precision.json', badPrecision)
      ]);
      expect(badPrecisionResult.status).toEqual(1);
      expect(badPrecisionResult.stderr).toContain('minPrecision');

      const badOp = baseDoc();
      badOp.entries[0].op = 'delete';
      const badOpResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'bad-op.json', badOp)
      ]);
      expect(badOpResult.status).toEqual(1);
      expect(badOpResult.stderr).toContain('"op"');

      const typoField = baseDoc();
      typoField.entries[0].minPrecison = 5;
      const typoResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'typo.json', typoField)
      ]);
      expect(typoResult.status).toEqual(1);
      expect(typoResult.stderr).toContain('unknown field "minPrecison"');

      // Number(null) is 0: a null coordinate must not silently become a valid
      // probe at latitude 0, because probes gate whether the apply commits.
      const nullCoordinate = baseDoc();
      nullCoordinate.entries[0].probes[0].lat = null;
      const nullCoordinateResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'null-coordinate.json', nullCoordinate)
      ]);
      expect(nullCoordinateResult.status).toEqual(1);
      expect(nullCoordinateResult.stderr).toContain('"lat" must be a number');

      // A structurally valid file whose name does not match its declared
      // country defeats the one-file-per-country boundary: an operator
      // applying gt.json expects only Guatemala to change.
      const wrongName = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'wrong-name.json', baseDoc())
      ]);
      expect(wrongName.status).toEqual(1);
      expect(wrongName.stderr).toContain('must be named us.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports affected rows in dry-run mode without writing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--dry-run']);
      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('would relabel 2 cell(s)');

      const after = await lookupSnapshot(dbPath);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies probes through the reverse geocoder after applying', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('Probes passed: 3, skipped: 0, failed: 0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back the overlay and exits nonzero when a probe mismatches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      const doc = baseDoc();
      doc.entries[0].probes = [
        { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'Big City', note: 'deliberately wrong' },
        { lat: coarseEastProbe.lat, lon: coarseEastProbe.lon, expect: 'East County', note: 'guard probe, passes' }
      ];
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('FAIL');
      expect(result.stderr).toContain('expected "Big City", got "Bystander County"');
      expect(result.stderr).toContain('rolled back');

      // The failed overlay must not survive: absorbed cells keep their owners.
      const after = await lookupSnapshot(dbPath);
      expect(after).toEqual(before);

      // On a database where all merge sources and the expected place own
      // cells, a mismatch is genuine and must fail even with the escape flag.
      const lenient = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(lenient.status).toEqual(1);
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defers failing probes when a merge source owns no cells yet, only with --skip-unresolvable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);

      // The shipped-Guatemala situation: the merge target ('Big City') already
      // owns cells elsewhere, but an absorbed place (Ghost Town) owns none, so
      // a probe describing the post-rebuild end state cannot pass yet.
      const doc = baseDoc();
      doc.entries[0].absorb = [EAST, WEST, GHOST];
      doc.entries[0].probes.push({
        lat: points.bystander.lat,
        lon: points.bystander.lon,
        expect: 'Big City',
        note: 'cannot pass until the absorbed place owns cells'
      });
      const docPath = writeDoc(dir, 'us.json', doc);

      const deferred = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(deferred.status).toEqual(0);
      expect(deferred.stderr).toContain(`merge source(s) ${GHOST} own no cells at precision >= 5`);
      expect(deferred.stdout).toContain('Probes passed: 3, skipped: 1, failed: 0');

      const strict = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(strict.status).toEqual(1);
      expect(strict.stderr).toContain('--skip-unresolvable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an entry referencing a place from another country', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      // HOMONYM is a real place, but it belongs to CA while the file declares
      // US: a typo'd id that happens to exist elsewhere must not pass
      // validation and relabel a foreign place's cells.
      const absorbForeign = baseDoc();
      absorbForeign.entries[0].absorb = [EAST, HOMONYM];
      const absorbResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'us.json', absorbForeign)
      ]);
      expect(absorbResult.status).toEqual(1);
      expect(absorbResult.stderr).toContain('belongs to country CA');

      const intoForeign = baseDoc();
      intoForeign.entries[0].into = HOMONYM;
      const intoResult = runCurate([
        '--database', dbPath,
        '--curation', writeDoc(dir, 'us.json', intoForeign)
      ]);
      expect(intoResult.status).toEqual(1);
      expect(intoResult.stderr).toContain('belongs to country CA');

      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not defer guard failures unrelated to a missing merge source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      // The entry has a missing source (Ghost Town owns no cells), which may
      // defer failing probes that expect the merge target — but a guard probe
      // expecting a different name fails for reasons unrelated to the missing
      // source and must still block the transaction, even with the flag.
      const doc = baseDoc();
      doc.entries[0].absorb = [EAST, GHOST];
      doc.entries[0].probes = [
        { lat: points.east.lat, lon: points.east.lon, expect: 'Big City', note: 'positive probe passes' },
        { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'West County', note: 'guard fails independently of the missing source' }
      ];
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('expected "West County", got "Bystander County"');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a merge target as resolvable once the overlay grants it cells', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      // Ghost Town owns no cells before the apply, but absorbing East County
      // gives it cells inside the transaction. A probe expecting Ghost Town
      // where the overlay did NOT reach exposes an incomplete absorb set and
      // must fail (resolvability is judged against the post-apply state), not
      // be deferred as if the target could never resolve.
      const doc = {
        country: 'US',
        entries: [
          {
            op: 'merge',
            into: GHOST,
            absorb: [EAST],
            minPrecision: 5,
            rationale: 'Synthetic: target owns cells only via the pending overlay.',
            probes: [
              { lat: points.east.lat, lon: points.east.lon, expect: 'Ghost Town', note: 'relabeled cell resolves to the target' },
              { lat: points.west.lat, lon: points.west.lon, expect: 'Ghost Town', note: 'outside the absorb set: genuine failure' },
              { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'Bystander County', note: 'guard probe, passes' }
            ]
          }
        ]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('expected "Ghost Town", got "West County"');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defers failing probes when a merge source owns cells only below minPrecision', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);

      // East County owns precision-4 and precision-5 cells, but this entry
      // relabels only cells at precision >= 6, so the merge is a no-op for it:
      // the source must count as unresolvable even though it owns SOME cells.
      const doc = {
        country: 'US',
        entries: [
          {
            op: 'merge',
            into: CITY,
            absorb: [EAST],
            minPrecision: 6,
            rationale: 'Synthetic: absorbed place owns no cells the entry can relabel yet.',
            probes: [
              { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'Bystander County', note: 'guard still passes' },
              { lat: points.east.lat, lon: points.east.lon, expect: 'Big City', note: 'needs precision-6 cells that do not exist yet' }
            ]
          }
        ]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const deferred = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(deferred.status).toEqual(0);
      expect(deferred.stderr).toContain(`merge source(s) ${EAST} own no cells at precision >= 6`);
      expect(deferred.stdout).toContain('Probes passed: 1, skipped: 1, failed: 0');

      const strict = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(strict.status).toEqual(1);
      expect(strict.stderr).toContain('--skip-unresolvable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the verification precision range from the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      // A database built entirely outside the library's default 4..7 range:
      // the only lookup row is a precision-8 cell. Verification must derive
      // the range from the data or it will never query this row.
      const dbPath = path.join(dir, 'fine.sqlite');
      const fineCell = geohash.encode(points.east.lat, points.east.lon, 8);
      const coarseGuardProbe = probeAvoidingChild(cells.eastCoarse, fineCell);
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

          INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude) VALUES
            (${CITY}, 'Big City', 'US', 5, 0, ${points.city.lat}, ${points.city.lon}),
            (${EAST}, 'East County', 'US', 5, 3, ${points.east.lat}, ${points.east.lon});

          INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES
            ('${cells.eastCoarse}', ${EAST}),
            ('${fineCell}', ${EAST});
        `);
      } finally {
        await close(db);
      }

      const doc = {
        country: 'US',
        entries: [
          {
            op: 'merge',
            into: CITY,
            absorb: [EAST],
            minPrecision: 8,
            rationale: 'Synthetic: exercise verification on a precision-8 database.',
            probes: [
              { lat: points.east.lat, lon: points.east.lon, expect: 'Big City', note: 'precision-8 cell' },
              { lat: coarseGuardProbe.lat, lon: coarseGuardProbe.lon, expect: 'East County', note: 'guard: coarse cell keeps its owner' }
            ]
          }
        ]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(result.status).toEqual(0);
      expect(result.stdout).toContain('Probes passed: 2, skipped: 0, failed: 0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects two entries absorbing the same place into different targets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      const doc = {
        country: 'US',
        entries: [conflictEntry(CITY, [EAST]), conflictEntry(BYSTANDER, [EAST])]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('conflicting "into" targets');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects merge chains where a target is itself absorbed by another entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      const doc = {
        country: 'US',
        entries: [conflictEntry(CITY, [EAST]), conflictEntry(EAST, [WEST])]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('merge chains are not allowed');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate absorption of the same place across entries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      // Loaded via a directory to also cover directory traversal.
      const curationDir = path.join(dir, 'curation');
      fs.mkdirSync(curationDir);
      writeDoc(curationDir, 'us.json', {
        country: 'US',
        entries: [conflictEntry(CITY, [EAST]), conflictEntry(CITY, [EAST, WEST])]
      });

      const result = runCurate(['--database', dbPath, '--curation', curationDir]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('duplicate absorption');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips probes whose expected place owns no cells only with --skip-unresolvable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);

      // Ghost Town (US) exists in compact_places but owns no lookup cells, and
      // the probed coordinate resolves to another place — the situation of a
      // curation file shipped ahead of the data build that makes it effective.
      // A same-named place in another country (CA) DOES own cells, so this
      // also pins down that resolvability is scoped to the entry's country.
      const doc = baseDoc();
      doc.entries[0].probes.push({
        lat: points.east.lat,
        lon: points.east.lon,
        expect: 'Ghost Town',
        note: 'expected place owns no cells yet'
      });
      const docPath = writeDoc(dir, 'us.json', doc);

      const skipped = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(skipped.status).toEqual(0);
      expect(skipped.stderr).toContain('"Ghost Town" (US) owns no cells in this database yet');
      expect(skipped.stdout).toContain('Probes passed: 3, skipped: 1, failed: 0');

      const strict = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(strict.status).toEqual(1);
      expect(strict.stderr).toContain('--skip-unresolvable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays strict on re-verification once a source was previously absorbed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      // First apply drains the sources' fine cells into the target.
      const first = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(first.status).toEqual(0);

      // Simulate a later regression: someone hands an absorbed cell to a
      // third place. On re-run the sources own no relabelable cells — but
      // that is because the overlay already consumed them, not because the
      // build lacks them, so verification must stay strict and catch this.
      const db = new sqlite3.Database(dbPath);
      try {
        await exec(db, `UPDATE compact_geohash_lookup SET place_id = ${BYSTANDER} WHERE geohash = '${cells.eastFine}'`);
      } finally {
        await close(db);
      }

      const second = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(second.status).toEqual(1);
      expect(second.stderr).toContain('expected "Big City", got "Bystander County"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes country id case when checking expected-place ownership', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      // The boundary builder preserves the source country string, so a
      // generated database can store lowercase country ids. A resolvable
      // mismatch must still fail: case differences must not turn it into a
      // deferrable "owns no cells" probe.
      const dbPath = path.join(dir, 'compact.sqlite');
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

          INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude) VALUES
            (${CITY}, 'Big City', 'us', 5, 0, ${points.city.lat}, ${points.city.lon}),
            (${BYSTANDER}, 'Bystander County', 'us', 5, 3, ${points.bystander.lat}, ${points.bystander.lon});

          INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES
            ('${cells.cityCoarse}', ${CITY}),
            ('${cells.bystanderCoarse}', ${BYSTANDER}),
            ('${cells.bystanderFine}', ${BYSTANDER});
        `);
      } finally {
        await close(db);
      }

      const doc = {
        country: 'US',
        entries: [
          {
            op: 'merge',
            into: CITY,
            absorb: [BYSTANDER],
            minPrecision: 5,
            rationale: 'Synthetic: database stores lowercase country ids.',
            probes: [
              { lat: points.bystander.lat, lon: points.bystander.lon, expect: 'Big City', note: 'absorbed cell resolves to the target' },
              { lat: points.city.lat, lon: points.city.lon, expect: 'Bystander County', note: 'deliberate mismatch: Bystander County still owns its coarse cell' }
            ]
          }
        ]
      };
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('expected "Bystander County", got "Big City"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets drain evidence when the compact tables are rebuilt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const docPath = writeDoc(dir, 'us.json', baseDoc());

      // First apply drains the sources' fine cells and journals it.
      const first = runCurate(['--database', dbPath, '--curation', docPath, '--verify']);
      expect(first.status).toEqual(0);

      // Simulate the boundary generator's replace mode: drop and recreate the
      // compact tables, producing a build where the counties own no fine
      // cells (the pre-rebuild world). The old drain evidence belongs to a
      // previous database generation and must not keep verification strict.
      const db = new sqlite3.Database(dbPath);
      try {
        await exec(db, `
          DROP TABLE compact_geohash_lookup;
          DROP TABLE compact_places;

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

          INSERT INTO compact_places(id, name, country_id, admin1_id, placetype_code, latitude, longitude) VALUES
            (${CITY}, 'Big City', 'US', 5, 0, ${points.city.lat}, ${points.city.lon}),
            (${EAST}, 'East County', 'US', 5, 3, ${points.east.lat}, ${points.east.lon}),
            (${WEST}, 'West County', 'US', 5, 3, ${points.west.lat}, ${points.west.lon}),
            (${BYSTANDER}, 'Bystander County', 'US', 5, 3, ${points.bystander.lat}, ${points.bystander.lon}),
            (${GHOST}, 'Ghost Town', 'US', 5, 0, ${points.ghost.lat}, ${points.ghost.lon}),
            (${HOMONYM}, 'Ghost Town', 'CA', 9, 0, ${points.homonym.lat}, ${points.homonym.lon});

          INSERT INTO compact_geohash_lookup(geohash, place_id) VALUES
            ('${cells.cityCoarse}', ${CITY}),
            ('${cells.eastCoarse}', ${EAST}),
            ('${cells.westCoarse}', ${WEST}),
            ('${cells.bystanderCoarse}', ${BYSTANDER}),
            ('${cells.bystanderFine}', ${BYSTANDER}),
            ('${cells.homonymFine}', ${HOMONYM});
        `);
      } finally {
        await close(db);
      }

      const second = runCurate(['--database', dbPath, '--curation', docPath, '--verify', '--skip-unresolvable']);
      expect(second.status).toEqual(0);
      expect(second.stderr).toContain('own no cells at precision >= 5');
      expect(second.stdout).toContain('Probes passed: 2, skipped: 1, failed: 0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an entry whose probes all expect the merge target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-geocoder-curation-'));
    try {
      const dbPath = path.join(dir, 'compact.sqlite');
      await seedCompactDb(dbPath);
      const before = await lookupSnapshot(dbPath);

      // Positive probes only cover the intended sources; without a guard
      // probe, a same-country typo absorbing an unrelated municipality would
      // pass verification completely unchecked.
      const doc = baseDoc();
      doc.entries[0].probes = [
        { lat: points.east.lat, lon: points.east.lon, expect: 'Big City' },
        { lat: points.west.lat, lon: points.west.lon, expect: 'Big City' }
      ];
      const docPath = writeDoc(dir, 'us.json', doc);

      const result = runCurate(['--database', dbPath, '--curation', docPath]);
      expect(result.status).toEqual(1);
      expect(result.stderr).toContain('guard probe');
      expect(await lookupSnapshot(dbPath)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a structurally valid Guatemala curation file', () => {
    const gtPath = path.join(__dirname, '..', 'curation', 'gt.json');
    const doc = JSON.parse(fs.readFileSync(gtPath, 'utf8'));

    let entries;
    expect(() => {
      entries = curation.validateCurationDocument(doc, 'curation/gt.json');
    }).not.toThrow();

    expect(entries.length).toEqual(1);
    expect(entries[0].op).toEqual('merge');
    expect(entries[0].into).toEqual(421169087);
    expect(entries[0].absorb).toEqual([421191461, 1108695621, 421185999]);
    expect(entries[0].minPrecision).toEqual(5);
    expect(entries[0].probes.length).toEqual(5);
  });
});
