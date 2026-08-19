#!/usr/bin/env node
"use strict";

const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')

const SUPPORTED_OPS = ['merge']
const MIN_PRECISION_FLOOR = 1
const MIN_PRECISION_CEILING = 12

const ENTRY_KEYS = ['op', 'into', 'absorb', 'minPrecision', 'rationale', 'probes']
const PROBE_KEYS = ['lat', 'lon', 'expect', 'note']
const DOCUMENT_KEYS = ['country', 'entries']

function parseArgs(argv) {
  var opts = {
    database: null,
    curation: [],
    dryRun: false,
    verify: false,
    skipUnresolvable: false,
    revert: false
  }

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]

    if (arg === '--database' || arg === '-d') {
      opts.database = argv[++i]
    } else if (arg === '--curation' || arg === '-c') {
      opts.curation.push(argv[++i])
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--verify') {
      opts.verify = true
    } else if (arg === '--skip-unresolvable') {
      opts.skipUnresolvable = true
    } else if (arg === '--revert') {
      opts.revert = true
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new Error('Unknown argument: ' + arg)
    }
  }

  return opts
}

function usage() {
  return [
    'Usage: node scripts/apply_curation.js --database <db.sqlite> --curation <file-or-dir> [options]',
    '',
    'Applies curation overlay files (see curation/README.md) to a compact v2',
    'boundary database. Every file and every place id is validated before',
    'anything is written; the apply itself runs in a single transaction.',
    '',
    'Options:',
    '  --database, -d       Compact boundary SQLite database to curate (required)',
    '  --curation, -c       Curation JSON file, or directory containing *.json files (repeatable, required)',
    '  --dry-run            Report per-entry affected row counts without writing',
    '  --verify             Run each entry\'s probes through the reverse geocoder inside the apply transaction; any mismatch rolls the overlay back',
    '  --skip-unresolvable  With --verify: downgrade a failing probe to a warning when the expected place or one of the entry\'s merge sources owns no cells yet',
    '  --revert             Restore every journaled cell to its original owner and clear the journal (run before an append-mode refresh of a curated database)',
    '  --help, -h           Show this help message'
  ].join('\n')
}

function collectCurationFiles(inputs) {
  var all = []

  for (var i = 0; i < inputs.length; i++) {
    var inputPath = path.resolve(inputs[i])
    if (!fs.existsSync(inputPath)) {
      throw new Error('Curation path does not exist: ' + inputPath)
    }

    if (fs.statSync(inputPath).isDirectory()) {
      var entries = fs.readdirSync(inputPath)
      var found = false
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].toLowerCase().endsWith('.json')) {
          all.push(path.join(inputPath, entries[j]))
          found = true
        }
      }
      if (!found) {
        throw new Error('No *.json curation files found in directory: ' + inputPath)
      }
    } else {
      all.push(inputPath)
    }
  }

  var dedup = Object.create(null)
  all.forEach(function(filePath) {
    dedup[filePath] = true
  })

  return Object.keys(dedup).sort()
}

function rejectUnknownKeys(object, allowedKeys, label) {
  var keys = Object.keys(object)
  for (var i = 0; i < keys.length; i++) {
    if (allowedKeys.indexOf(keys[i]) === -1) {
      throw new Error(label + ': unknown field "' + keys[i] + '" (allowed: ' + allowedKeys.join(', ') + ')')
    }
  }
}

function validatePlaceId(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive integer place id, got: ' + JSON.stringify(value))
  }
  return value
}

function validateProbe(probe, label) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new Error(label + ' must be an object')
  }

  rejectUnknownKeys(probe, PROBE_KEYS, label)

  // Check the original type: Number(null), Number(false), and Number('') all
  // coerce to 0, which would silently turn a malformed probe into a "valid"
  // probe at coordinate 0 — and probes gate whether the apply commits.
  var lat = probe.lat
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(label + ': "lat" must be a number between -90 and 90')
  }

  var lon = probe.lon
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error(label + ': "lon" must be a number between -180 and 180')
  }

  if (typeof probe.expect !== 'string' || !probe.expect.trim()) {
    throw new Error(label + ': "expect" must be a non-empty place name string')
  }

  if (probe.note !== undefined && (typeof probe.note !== 'string' || !probe.note.trim())) {
    throw new Error(label + ': "note" must be a non-empty string when present')
  }

  return {
    lat: lat,
    lon: lon,
    expect: probe.expect.trim(),
    note: probe.note ? probe.note.trim() : null
  }
}

function validateEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(label + ' must be an object')
  }

  rejectUnknownKeys(entry, ENTRY_KEYS, label)

  if (SUPPORTED_OPS.indexOf(entry.op) === -1) {
    throw new Error(label + ': "op" must be one of: ' + SUPPORTED_OPS.join(', '))
  }

  var into = validatePlaceId(entry.into, label + ': "into"')

  if (!Array.isArray(entry.absorb) || !entry.absorb.length) {
    throw new Error(label + ': "absorb" must be a non-empty array of place ids')
  }

  var absorb = []
  var seen = Object.create(null)
  for (var i = 0; i < entry.absorb.length; i++) {
    var id = validatePlaceId(entry.absorb[i], label + ': "absorb[' + i + ']"')
    if (seen[id]) {
      throw new Error(label + ': duplicate id ' + id + ' in "absorb"')
    }
    if (id === into) {
      throw new Error(label + ': id ' + id + ' appears as both "into" and an "absorb" entry')
    }
    seen[id] = true
    absorb.push(id)
  }

  if (!Number.isInteger(entry.minPrecision) ||
    entry.minPrecision < MIN_PRECISION_FLOOR ||
    entry.minPrecision > MIN_PRECISION_CEILING) {
    throw new Error(label + ': "minPrecision" must be an integer between ' +
      MIN_PRECISION_FLOOR + ' and ' + MIN_PRECISION_CEILING)
  }

  if (typeof entry.rationale !== 'string' || !entry.rationale.trim()) {
    throw new Error(label + ': "rationale" must be a non-empty string explaining the judgment call')
  }

  if (!Array.isArray(entry.probes) || !entry.probes.length) {
    throw new Error(label + ': "probes" must be a non-empty array of probe points')
  }

  var probes = []
  for (var j = 0; j < entry.probes.length; j++) {
    probes.push(validateProbe(entry.probes[j], label + ': probes[' + j + ']'))
  }

  return {
    op: entry.op,
    into: into,
    absorb: absorb,
    minPrecision: entry.minPrecision,
    rationale: entry.rationale.trim(),
    probes: probes
  }
}

function validateCurationDocument(doc, label) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(label + ': root must be an object')
  }

  rejectUnknownKeys(doc, DOCUMENT_KEYS, label)

  if (typeof doc.country !== 'string' || !/^[A-Z]{2}$/.test(doc.country)) {
    throw new Error(label + ': "country" must be a two-letter uppercase ISO code')
  }

  if (!Array.isArray(doc.entries) || !doc.entries.length) {
    throw new Error(label + ': "entries" must be a non-empty array')
  }

  var entries = []
  for (var i = 0; i < doc.entries.length; i++) {
    var entry = validateEntry(doc.entries[i], label + ' entry ' + (i + 1))
    entry.country = doc.country
    entry.source = label
    entry.index = i + 1
    entries.push(entry)
  }

  return entries
}

function loadCurationEntries(files) {
  var entries = []

  for (var i = 0; i < files.length; i++) {
    var filePath = files[i]
    var doc
    try {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
      throw new Error('Failed to parse curation file ' + filePath + ': ' + err.message)
    }

    var fileEntries = validateCurationDocument(doc, filePath)

    // One country per file is a safety boundary: an operator applying
    // gt.json expects only Guatemala to change, so the filename must match
    // the declared country.
    var baseName = path.basename(filePath)
    var stem = baseName.replace(/\.[^.]*$/, '')
    if (stem.toLowerCase() !== doc.country.toLowerCase()) {
      throw new Error('Curation file ' + filePath + ' declares country "' + doc.country +
        '" but is named "' + baseName + '"; one country per file, so it must be named ' +
        doc.country.toLowerCase() + '.json')
    }

    entries = entries.concat(fileEntries)
  }

  return entries
}

// Cross-entry validation over ALL loaded curation files. Guarantees that
// every lookup row is touched by at most one entry, which makes application
// order irrelevant and keeps the overall apply idempotent.
function validateAcrossEntries(entries) {
  var absorbClaims = Object.create(null)
  var intoClaims = Object.create(null)

  entries.forEach(function(entry) {
    var label = entry.source + ' entry ' + entry.index

    if (!intoClaims[entry.into]) {
      intoClaims[entry.into] = []
    }
    intoClaims[entry.into].push(label)

    entry.absorb.forEach(function(id) {
      if (!absorbClaims[id]) {
        absorbClaims[id] = []
      }
      absorbClaims[id].push({ label: label, into: entry.into })
    })
  })

  var problems = []

  Object.keys(absorbClaims).forEach(function(id) {
    var claims = absorbClaims[id]
    if (claims.length < 2) {
      return
    }

    var targets = Object.create(null)
    claims.forEach(function(claim) {
      targets[claim.into] = true
    })

    var descriptor = Object.keys(targets).length > 1
      ? 'is absorbed by multiple entries with conflicting "into" targets'
      : 'is absorbed by multiple entries with the same target (duplicate absorption; keep one entry per absorbed place)'

    problems.push('place id ' + id + ' ' + descriptor + ': ' +
      claims.map(function(claim) { return claim.label + ' -> ' + claim.into }).join('; '))
  })

  Object.keys(intoClaims).forEach(function(id) {
    if (!absorbClaims[id]) {
      return
    }

    problems.push('place id ' + id + ' is a merge target (' + intoClaims[id].join('; ') +
      ') and is also absorbed (' +
      absorbClaims[id].map(function(claim) { return claim.label }).join('; ') +
      '); merge chains are not allowed')
  })

  if (problems.length) {
    throw new Error('Curation conflict validation failed:\n  ' + problems.join('\n  '))
  }
}

function dbAll(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(err, rows) {
      if (err) reject(err)
      else resolve(rows || [])
    })
  })
}

function dbRun(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.run(sql, params || [], function(err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

function dbExec(db, sql) {
  return new Promise(function(resolve, reject) {
    db.exec(sql, function(err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

function dbClose(db) {
  return new Promise(function(resolve, reject) {
    db.close(function(err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function assertCompactSchema(db, databasePath) {
  var rows = await dbAll(db, `
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name IN ('compact_places', 'compact_geohash_lookup')
  `)

  if (rows.length !== 2) {
    throw new Error('Not a compact v2 boundary database (missing compact_places/compact_geohash_lookup): ' + databasePath)
  }
}

async function assertPlaceIdsExist(db, entries) {
  var wanted = Object.create(null)
  entries.forEach(function(entry) {
    wanted[entry.into] = true
    entry.absorb.forEach(function(id) {
      wanted[id] = true
    })
  })

  var ids = Object.keys(wanted).map(Number)
  var placeholders = ids.map(function() { return '?' }).join(', ')
  var rows = await dbAll(db, 'SELECT id, country_id FROM compact_places WHERE id IN (' + placeholders + ')', ids)

  var countryById = Object.create(null)
  rows.forEach(function(row) {
    countryById[row.id] = String(row.country_id || '').toUpperCase()
  })

  // A referenced id must exist AND belong to the file's declared country: a
  // typo'd id that happens to identify a real place in another country must
  // not silently relabel that foreign place's cells.
  function checkId(id, role, entry, problems) {
    var label = entry.source + ' entry ' + entry.index
    if (countryById[id] === undefined) {
      problems.push('place id ' + id + ' ("' + role + '", ' + label + ') not found in compact_places')
    } else if (countryById[id] !== entry.country) {
      problems.push('place id ' + id + ' ("' + role + '", ' + label + ') belongs to country ' +
        (countryById[id] || '<none>') + ', not ' + entry.country)
    }
  }

  var problems = []
  entries.forEach(function(entry) {
    checkId(entry.into, 'into', entry, problems)
    entry.absorb.forEach(function(id) {
      checkId(id, 'absorb', entry, problems)
    })
  })

  if (problems.length) {
    throw new Error('Curation validation failed:\n  ' + problems.join('\n  '))
  }
}

async function describePlace(db, placeId) {
  var rows = await dbAll(db, 'SELECT name FROM compact_places WHERE id = ?', [placeId])
  return rows.length ? rows[0].name : String(placeId)
}

// Every entry must carry both probe roles. Probes that only expect the merge
// target prove nothing about where the merge must NOT reach: a typo'd absorb
// id relabeling an unrelated municipality would sail through verification.
// Probes that only guard other places never exercise the intended relabeling:
// --verify could commit a merge that changed the wrong cells or none at all.
async function assertGuardProbes(db, entries) {
  var problems = []

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var intoName = await describePlace(db, entry.into)
    var hasGuard = false
    var hasPositive = false

    for (var j = 0; j < entry.probes.length; j++) {
      if (entry.probes[j].expect === intoName) {
        hasPositive = true
      } else {
        hasGuard = true
      }
    }

    if (!hasGuard) {
      problems.push(entry.source + ' entry ' + entry.index + ': every probe expects the merge target "' +
        intoName + '"; add at least one guard probe pinning down where the merge must not reach')
    }
    if (!hasPositive) {
      problems.push(entry.source + ' entry ' + entry.index + ': no probe expects the merge target "' +
        intoName + '"; add at least one positive probe that exercises the relabeling')
    }
  }

  if (problems.length) {
    throw new Error('Curation validation failed:\n  ' + problems.join('\n  '))
  }
}

async function countAffectedRows(db, entry) {
  var placeholders = entry.absorb.map(function() { return '?' }).join(', ')
  var rows = await dbAll(db, `
    SELECT COUNT(*) AS count
    FROM compact_geohash_lookup
    WHERE place_id IN (${placeholders})
      AND LENGTH(geohash) >= ?
  `, entry.absorb.concat([entry.minPrecision]))

  return rows.length ? rows[0].count : 0
}

// Journaled cells below the entry's current minPrecision that are still
// owned by the merge target: an apply would return these to their original
// owners (see the reconciliation note on applyEntry).
async function countReturnableCells(db, entry, journalTrusted) {
  if (!journalTrusted) {
    return 0
  }

  var placeholders = entry.absorb.map(function() { return '?' }).join(', ')
  var rows = await dbAll(db, `
    SELECT COUNT(*) AS count
    FROM curation_journal_cells c
    JOIN compact_geohash_lookup l ON l.geohash = c.geohash AND l.place_id = c.into_id
    WHERE c.into_id = ?
      AND c.absorbed_id IN (${placeholders})
      AND LENGTH(c.geohash) < ?
  `, [entry.into].concat(entry.absorb).concat([entry.minPrecision]))

  return rows.length ? rows[0].count : 0
}

// One UPDATE per source (sources are disjoint after conflict validation, so
// this is equivalent to a single IN-list update) so each drained cell can be
// journaled with its original owner. Verification uses the per-cell records
// to distinguish a source the build never had from one a previous apply
// already drained — at the precision that actually matters — and --revert
// uses them to restore original ownership before an append-mode refresh.
//
// Applying is a RECONCILIATION to the entry as currently written: cells a
// previous revision drained that the current minPrecision now defines as
// coarse (journaled cells below the threshold) are returned to their
// original owners first, so raising minPrecision does not silently leave the
// old, broader merge in place. Cells something else has since overwritten
// are left alone; their journal records are retired either way.
async function applyEntry(db, entry) {
  var relabeled = 0
  var returned = 0

  for (var i = 0; i < entry.absorb.length; i++) {
    var sourceId = entry.absorb[i]

    var staleCells = await dbAll(db, `
      SELECT geohash
      FROM curation_journal_cells
      WHERE into_id = ?
        AND absorbed_id = ?
        AND LENGTH(geohash) < ?
    `, [entry.into, sourceId, entry.minPrecision])

    var returnedForSource = 0
    for (var s = 0; s < staleCells.length; s++) {
      var restore = await dbRun(db, `
        UPDATE compact_geohash_lookup
        SET place_id = ?
        WHERE geohash = ?
          AND place_id = ?
      `, [sourceId, staleCells[s].geohash, entry.into])

      if (restore.changes) {
        returnedForSource += 1
      }

      await dbRun(db, 'DELETE FROM curation_journal_cells WHERE geohash = ?', [staleCells[s].geohash])
    }

    if (returnedForSource) {
      returned += returnedForSource
      await dbRun(db, `
        UPDATE curation_journal
        SET cells_relabeled = MAX(0, cells_relabeled - ?)
        WHERE into_id = ?
          AND absorbed_id = ?
      `, [returnedForSource, entry.into, sourceId])
    }

    var cellRows = await dbAll(db, `
      SELECT geohash
      FROM compact_geohash_lookup
      WHERE place_id = ?
        AND LENGTH(geohash) >= ?
    `, [sourceId, entry.minPrecision])

    for (var c = 0; c < cellRows.length; c++) {
      await dbRun(db, `
        INSERT OR REPLACE INTO curation_journal_cells(geohash, into_id, absorbed_id)
        VALUES (?, ?, ?)
      `, [cellRows[c].geohash, entry.into, sourceId])
    }

    var result = await dbRun(db, `
      UPDATE compact_geohash_lookup
      SET place_id = ?
      WHERE place_id = ?
        AND LENGTH(geohash) >= ?
    `, [entry.into, sourceId, entry.minPrecision])

    var changes = result.changes || 0
    relabeled += changes

    await dbRun(db, `
      INSERT INTO curation_journal(into_id, absorbed_id, min_precision, cells_relabeled, applied_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(into_id, absorbed_id) DO UPDATE SET
        cells_relabeled = cells_relabeled + excluded.cells_relabeled,
        min_precision = excluded.min_precision,
        applied_at = excluded.applied_at
    `, [entry.into, sourceId, entry.minPrecision, changes])
  }

  return { relabeled: relabeled, returned: returned }
}

function entryLabel(entry, intoName) {
  return 'merge into ' + entry.into + ' (' + intoName + '), absorbing [' +
    entry.absorb.join(', ') + '] at precision >= ' + entry.minPrecision
}

// Scoped to the entry's country so that a homonymous place elsewhere in the
// world cannot make an expected name look resolvable. Country ids are
// case-normalized on both sides, consistently with assertPlaceIdsExist,
// because generated databases preserve the source country string's case.
async function expectedPlaceOwnsCells(db, name, countryId) {
  var rows = await dbAll(db, `
    SELECT COUNT(*) AS count
    FROM compact_geohash_lookup l
    JOIN compact_places p ON p.id = l.place_id
    WHERE p.name = ?
      AND UPPER(p.country_id) = ?
  `, [name, String(countryId).toUpperCase()])

  return Boolean(rows.length && rows[0].count > 0)
}

// Counts only cells the entry could actually relabel: a place owning cells
// solely below minPrecision still makes the merge a no-op for that source.
async function placeOwnsRelabelableCells(db, placeId, minPrecision) {
  var rows = await dbAll(db, `
    SELECT COUNT(*) AS count
    FROM compact_geohash_lookup
    WHERE place_id = ?
      AND LENGTH(geohash) >= ?
  `, [placeId, minPrecision])

  return Boolean(rows.length && rows[0].count > 0)
}

// The reverse lookup only queries geohash lengths inside its configured
// precision range, so derive that range from the database being curated
// instead of relying on the library defaults (base 4, max 7).
async function deriveBoundaryPrecision(db) {
  var rows = await dbAll(db, `
    SELECT MIN(LENGTH(geohash)) AS minLength, MAX(LENGTH(geohash)) AS maxLength
    FROM compact_geohash_lookup
  `)

  var min = rows.length ? rows[0].minLength : null
  var max = rows.length ? rows[0].maxLength : null

  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    return { basePrecision: 4, maxPrecision: 7 }
  }

  return { basePrecision: min, maxPrecision: max }
}

// The apply records which sources it drained in a small bookkeeping table
// inside the curated database. A source owning no relabelable cells is
// ambiguous on its own: either the data build never had them (defer probes),
// or a previous apply already moved them to the target (stay strict). The
// journal disambiguates the two so re-verification of an already-curated
// database cannot become vacuous.
//
// The journal is tied to the current compact-table generation through an
// inert marker trigger on compact_geohash_lookup: SQLite drops a table's
// triggers with the table, so a replace-mode rebuild (which drops and
// recreates the compact tables) kills the marker while leaving the journal.
// Journal present + marker gone therefore means the drain evidence describes
// a previous database generation and must not be trusted; the next apply
// clears it and re-creates the marker. In-place edits (including cell
// corruption, which verification must stay strict about) never drop the
// table, so the marker survives them.
var JOURNAL_MARKER_TRIGGER = 'curation_journal_generation_marker'

async function journalState(db) {
  var rows = await dbAll(db, `
    SELECT name, type
    FROM sqlite_master
    WHERE (type='table' AND name IN ('curation_journal', 'curation_journal_cells'))
       OR (type='trigger' AND name='${JOURNAL_MARKER_TRIGGER}')
  `)

  var tables = 0
  var markerPresent = false
  rows.forEach(function(row) {
    if (row.type === 'table') tables += 1
    if (row.type === 'trigger') markerPresent = true
  })

  var present = tables === 2
  return {
    present: present,
    trusted: present && markerPresent
  }
}

async function ensureCurationJournal(db, journal) {
  await dbExec(db, `
    CREATE TABLE IF NOT EXISTS curation_journal(
      into_id INTEGER NOT NULL,
      absorbed_id INTEGER NOT NULL,
      min_precision INTEGER NOT NULL,
      cells_relabeled INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (into_id, absorbed_id)
    );

    CREATE TABLE IF NOT EXISTS curation_journal_cells(
      geohash TEXT PRIMARY KEY,
      into_id INTEGER NOT NULL,
      absorbed_id INTEGER NOT NULL
    );
  `)

  if (journal.present && !journal.trusted) {
    await dbRun(db, 'DELETE FROM curation_journal')
    await dbRun(db, 'DELETE FROM curation_journal_cells')
  }

  // Inert by design: this trigger's body does nothing, and the deletes the
  // generator's append mode performs pass through it harmlessly. Its only
  // job is to die with the table on a replace-mode rebuild (SQLite drops a
  // table's triggers with the table), marking the journal as stale.
  await dbExec(db, `
    CREATE TRIGGER IF NOT EXISTS ${JOURNAL_MARKER_TRIGGER}
    AFTER DELETE ON compact_geohash_lookup
    BEGIN
      SELECT 1;
    END
  `)
}

// Evidence is per drained cell, so it is scoped to the precision that
// matters: cells drained by an earlier precision-5 revision of an entry do
// not vouch for a precision-6 revision unless cells of length >= 6 were
// actually among them.
async function sourcePreviouslyDrained(db, journalTrusted, intoId, sourceId, minPrecision) {
  if (!journalTrusted) {
    return false
  }

  var rows = await dbAll(db, `
    SELECT geohash
    FROM curation_journal_cells
    WHERE into_id = ?
      AND absorbed_id = ?
      AND LENGTH(geohash) >= ?
    LIMIT 1
  `, [intoId, sourceId, minPrecision])

  return rows.length > 0
}

// Snapshot, before anything is written, which absorbed places own no cells
// the entry could relabel (at or above its minPrecision) — the apply itself
// drains sources, so this must be measured pre-apply. A source with journal
// evidence of a previous drain is never treated as missing: its cells are
// gone because the overlay consumed them, not because the build lacks them.
// Verification uses this to tell a genuine mismatch from a curation file that
// shipped ahead of the data build that makes it effective.
async function computeResolvability(db, entries) {
  var missingSourcesByEntry = Object.create(null)
  var journal = await journalState(db)

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var missing = []

    for (var j = 0; j < entry.absorb.length; j++) {
      var sourceId = entry.absorb[j]
      if (await placeOwnsRelabelableCells(db, sourceId, entry.minPrecision)) {
        continue
      }
      if (await sourcePreviouslyDrained(db, journal.trusted, entry.into, sourceId, entry.minPrecision)) {
        continue
      }
      missing.push(sourceId)
    }
    missingSourcesByEntry[entry.source + '#' + entry.index] = missing
  }

  return {
    missingSourcesByEntry: missingSourcesByEntry
  }
}

// Runs probes on the shared connection so they see the uncommitted overlay;
// the caller decides whether to commit or roll back based on the verdict.
//
// Deferral reasons are per probe:
// - The expected place owning no cells is judged against the POST-apply
//   transaction state: when the pending merge itself grants the target cells,
//   a failing probe expecting the target exposes an incomplete absorb set and
//   is a genuine failure, not an unresolvable probe.
// - Missing merge sources (snapshotted PRE-apply, since the apply drains
//   them) only defer probes that expect the merge target's name. Guard probes
//   expecting any other name do not depend on the missing source and must
//   keep blocking the transaction.
async function verifyEntries(db, entries, skipUnresolvable, boundary, resolvability) {
  var createGeocoder = require('../src/index.js')
  var geocoder = createGeocoder({
    db: db,
    reverseMode: 'boundary',
    reverseDebug: true,
    boundary: boundary
  })

  var passed = 0
  var skipped = 0
  var failures = []
  var expectOwnsCache = Object.create(null)

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var missingSources = resolvability.missingSourcesByEntry[entry.source + '#' + entry.index] || []
    var intoName = await describePlace(db, entry.into)

    for (var j = 0; j < entry.probes.length; j++) {
      var probe = entry.probes[j]
      var context = entry.source + ' entry ' + entry.index +
        ' probe (' + probe.lat + ', ' + probe.lon + ')' +
        (probe.note ? ' [' + probe.note + ']' : '')

      var result = await geocoder.reverse(probe.lat, probe.lon)
      var actual = result && result.name
      var resolvedVia = result && result._debug && result._debug.reason

      // Positive probes (those expecting the merge target) must resolve to
      // the target's actual place id, not merely a same-named place: with
      // two homonymous places in one country, a name-only comparison would
      // let a probe outside the relabeled cells mask an incomplete merge.
      // They must also resolve FROM A LOOKUP CELL: the nearest-centroid
      // fallback can return the target itself for a coordinate no cell
      // covers, which would pass without exercising any relabeled cell.
      var isPositive = probe.expect === intoName
      var idMatches = !isPositive || Boolean(result && Number(result.id) === entry.into)
      var pathMatches = !isPositive || resolvedVia === 'geohash_lookup'

      if (actual === probe.expect && idMatches && pathMatches) {
        console.log('PASS ' + context + ' -> "' + actual + '"')
        passed += 1
        continue
      }

      var expectKey = entry.country + '|' + probe.expect
      if (expectOwnsCache[expectKey] === undefined) {
        expectOwnsCache[expectKey] = await expectedPlaceOwnsCells(db, probe.expect, entry.country)
      }

      var reasons = []
      if (!expectOwnsCache[expectKey]) {
        reasons.push('expected place "' + probe.expect + '" (' + entry.country + ') owns no cells in this database yet')
      }
      if (missingSources.length && probe.expect === intoName) {
        reasons.push('merge source(s) ' + missingSources.join(', ') + ' own no cells at precision >= ' + entry.minPrecision + ' in this database yet')
      }

      if (reasons.length && skipUnresolvable) {
        console.warn('SKIP ' + context + ': ' + reasons.join('; '))
        skipped += 1
        continue
      }

      var hint = reasons.length
        ? ' (' + reasons.join('; ') + '; rerun with --skip-unresolvable to defer this probe)'
        : ''
      var got = '"' + (actual || '<nothing>') + '"'
      if (actual === probe.expect && !idMatches) {
        got = '"' + actual + '" (same-named place ' + (result && result.id) + ', not the merge target ' + entry.into + ')'
      } else if (actual === probe.expect && !pathMatches) {
        got = '"' + actual + '" via ' + (resolvedVia || 'an unknown path') +
          ' (did not resolve from a lookup cell; the overlay does not cover this coordinate)'
      }
      failures.push('FAIL ' + context + ': expected "' + probe.expect + '", got ' + got + hint)
    }
  }

  return { passed: passed, skipped: skipped, failures: failures }
}

// Restores every journaled cell that is still owned by its merge target back
// to its original (absorbed) owner, then clears the journal. This is the
// supported way to prepare a curated database for the generator's append
// mode, whose per-place cleanup deletes cells by CURRENT ownership: without
// the revert, cells curation relabeled to the target could never be cleaned
// up when the absorbed place is re-imported, leaving stale reverse results.
async function runRevert(databasePath) {
  var db = new sqlite3.Database(databasePath)

  try {
    await assertCompactSchema(db, databasePath)

    var journal = await journalState(db)
    if (!journal.present) {
      throw new Error('No curation journal found in ' + databasePath + '; nothing to revert')
    }
    if (!journal.trusted) {
      throw new Error('The curation journal in ' + databasePath +
        ' describes a previous database generation (the compact tables were rebuilt); nothing to revert - re-apply curation instead')
    }

    var restored = 0
    var skippedCells = 0

    await dbExec(db, 'BEGIN')
    try {
      var cellRows = await dbAll(db, 'SELECT geohash, into_id, absorbed_id FROM curation_journal_cells')

      for (var i = 0; i < cellRows.length; i++) {
        var cell = cellRows[i]
        var result = await dbRun(db, `
          UPDATE compact_geohash_lookup
          SET place_id = ?
          WHERE geohash = ?
            AND place_id = ?
        `, [cell.absorbed_id, cell.geohash, cell.into_id])

        if (result.changes) {
          restored += 1
        } else {
          skippedCells += 1
        }
      }

      await dbRun(db, 'DELETE FROM curation_journal_cells')
      await dbRun(db, 'DELETE FROM curation_journal')

      await dbExec(db, 'COMMIT')
    } catch (err) {
      await dbExec(db, 'ROLLBACK')
      throw err
    }

    console.log('Curation revert complete')
    console.log('Database: ' + databasePath)
    console.log('Cells restored: ' + restored)
    console.log('Cells skipped (no longer owned by their merge target): ' + skippedCells)
  } finally {
    await dbClose(db)
  }
}

async function main() {
  var options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(usage())
    process.exit(0)
  }

  if (!options.database) {
    throw new Error('Missing required --database argument')
  }

  if (options.revert) {
    if (options.curation.length) {
      throw new Error('--revert restores from the journal and takes no --curation files')
    }
    if (options.dryRun || options.verify) {
      throw new Error('--revert cannot be combined with --dry-run or --verify')
    }

    var revertDatabasePath = path.resolve(options.database)
    if (!fs.existsSync(revertDatabasePath)) {
      throw new Error('Database does not exist: ' + revertDatabasePath)
    }

    await runRevert(revertDatabasePath)
    return
  }

  if (!options.curation.length) {
    throw new Error('Provide at least one --curation file or directory')
  }

  if (options.dryRun && options.verify) {
    throw new Error('--verify cannot be combined with --dry-run (probes describe the post-apply state)')
  }

  var databasePath = path.resolve(options.database)
  if (!fs.existsSync(databasePath)) {
    throw new Error('Database does not exist: ' + databasePath)
  }

  var files = collectCurationFiles(options.curation)
  var entries = loadCurationEntries(files)
  validateAcrossEntries(entries)

  var db = new sqlite3.Database(databasePath)
  var totalRelabeled = 0

  try {
    await assertCompactSchema(db, databasePath)
    await assertPlaceIdsExist(db, entries)
    await assertGuardProbes(db, entries)

    if (options.dryRun) {
      var dryRunJournal = await journalState(db)
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        var intoName = await describePlace(db, entry.into)
        var count = await countAffectedRows(db, entry)
        var returnable = await countReturnableCells(db, entry, dryRunJournal.trusted)
        totalRelabeled += count
        console.log('[dry-run] ' + entryLabel(entry, intoName) + ': would relabel ' + count + ' cell(s)' +
          (returnable ? ' and return ' + returnable + ' coarse cell(s) to their original owners' : ''))
      }
    } else {
      var journal = await journalState(db)
      var boundary = null
      var resolvability = null
      if (options.verify) {
        boundary = await deriveBoundaryPrecision(db)
        resolvability = await computeResolvability(db, entries)
      }

      await dbExec(db, 'BEGIN')
      try {
        await ensureCurationJournal(db, journal)

        for (var j = 0; j < entries.length; j++) {
          var applied = entries[j]
          var appliedIntoName = await describePlace(db, applied.into)
          var changes = await applyEntry(db, applied)
          totalRelabeled += changes.relabeled
          console.log(entryLabel(applied, appliedIntoName) + ': relabeled ' + changes.relabeled + ' cell(s)' +
            (changes.returned ? ', returned ' + changes.returned + ' coarse cell(s) to their original owners' : ''))
        }

        if (options.verify) {
          var verdict = await verifyEntries(db, entries, options.skipUnresolvable, boundary, resolvability)

          verdict.failures.forEach(function(line) {
            console.error(line)
          })
          console.log('Probes passed: ' + verdict.passed + ', skipped: ' + verdict.skipped + ', failed: ' + verdict.failures.length)

          if (verdict.failures.length) {
            throw new Error('Probe verification failed: ' + verdict.failures.length +
              ' probe(s) did not match; rolled back all curation changes, the database is unchanged')
          }
        }

        await dbExec(db, 'COMMIT')
      } catch (err) {
        await dbExec(db, 'ROLLBACK')
        throw err
      }
    }
  } finally {
    await dbClose(db)
  }

  console.log(options.dryRun ? 'Curation dry run complete' : 'Curation apply complete')
  console.log('Database: ' + databasePath)
  console.log('Curation files: ' + files.length)
  console.log('Entries: ' + entries.length)
  console.log((options.dryRun ? 'Cells that would be relabeled: ' : 'Cells relabeled: ') + totalRelabeled)
}

module.exports = {
  parseArgs: parseArgs,
  usage: usage,
  collectCurationFiles: collectCurationFiles,
  validateCurationDocument: validateCurationDocument,
  validateAcrossEntries: validateAcrossEntries
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err.message || err)
    process.exit(1)
  })
}
