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
    skipUnresolvable: false
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
    '  --verify             After applying, run each entry\'s probes through the reverse geocoder',
    '  --skip-unresolvable  With --verify: skip (with a warning) probes whose expected place owns no cells yet',
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

  var lat = Number(probe.lat)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(label + ': "lat" must be a number between -90 and 90')
  }

  var lon = Number(probe.lon)
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
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

    entries = entries.concat(validateCurationDocument(doc, filePath))
  }

  return entries
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
  var rows = await dbAll(db, 'SELECT id FROM compact_places WHERE id IN (' + placeholders + ')', ids)

  var found = Object.create(null)
  rows.forEach(function(row) {
    found[row.id] = true
  })

  var problems = []
  entries.forEach(function(entry) {
    var label = entry.source + ' entry ' + entry.index
    if (!found[entry.into]) {
      problems.push('place id ' + entry.into + ' ("into", ' + label + ') not found in compact_places')
    }
    entry.absorb.forEach(function(id) {
      if (!found[id]) {
        problems.push('place id ' + id + ' ("absorb", ' + label + ') not found in compact_places')
      }
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

async function applyEntry(db, entry) {
  var placeholders = entry.absorb.map(function() { return '?' }).join(', ')
  var result = await dbRun(db, `
    UPDATE compact_geohash_lookup
    SET place_id = ?
    WHERE place_id IN (${placeholders})
      AND LENGTH(geohash) >= ?
  `, [entry.into].concat(entry.absorb).concat([entry.minPrecision]))

  return result.changes || 0
}

function entryLabel(entry, intoName) {
  return 'merge into ' + entry.into + ' (' + intoName + '), absorbing [' +
    entry.absorb.join(', ') + '] at precision >= ' + entry.minPrecision
}

async function expectedPlaceOwnsCells(db, name) {
  var rows = await dbAll(db, `
    SELECT COUNT(*) AS count
    FROM compact_geohash_lookup l
    JOIN compact_places p ON p.id = l.place_id
    WHERE p.name = ?
  `, [name])

  return Boolean(rows.length && rows[0].count > 0)
}

async function verifyEntries(databasePath, entries, skipUnresolvable) {
  var createGeocoder = require('../src/index.js')
  var geocoder = createGeocoder({
    database: databasePath,
    reverseMode: 'boundary'
  })

  var passed = 0
  var skipped = 0
  var failures = []

  try {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]

      for (var j = 0; j < entry.probes.length; j++) {
        var probe = entry.probes[j]
        var context = entry.source + ' entry ' + entry.index +
          ' probe (' + probe.lat + ', ' + probe.lon + ')' +
          (probe.note ? ' [' + probe.note + ']' : '')

        var resolvable = await expectedPlaceOwnsCells(geocoder.db, probe.expect)
        if (!resolvable && skipUnresolvable) {
          console.warn('SKIP ' + context + ': expected place "' + probe.expect + '" owns no cells in this database yet')
          skipped += 1
          continue
        }

        var result = await geocoder.reverse(probe.lat, probe.lon)
        var actual = result && result.name

        if (actual === probe.expect) {
          console.log('PASS ' + context + ' -> "' + actual + '"')
          passed += 1
        } else {
          var hint = resolvable ? '' : ' (expected place owns no cells; rerun with --skip-unresolvable to defer this probe)'
          failures.push('FAIL ' + context + ': expected "' + probe.expect + '", got "' + (actual || '<nothing>') + '"' + hint)
        }
      }
    }
  } finally {
    if (geocoder.db && typeof geocoder.db.close === 'function') {
      await dbClose(geocoder.db)
    }
  }

  failures.forEach(function(line) {
    console.error(line)
  })

  console.log('Probes passed: ' + passed + ', skipped: ' + skipped + ', failed: ' + failures.length)

  if (failures.length) {
    throw new Error('Probe verification failed: ' + failures.length + ' probe(s) did not match')
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

  var db = new sqlite3.Database(databasePath)
  var totalRelabeled = 0

  try {
    await assertCompactSchema(db, databasePath)
    await assertPlaceIdsExist(db, entries)

    if (options.dryRun) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        var intoName = await describePlace(db, entry.into)
        var count = await countAffectedRows(db, entry)
        totalRelabeled += count
        console.log('[dry-run] ' + entryLabel(entry, intoName) + ': would relabel ' + count + ' cell(s)')
      }
    } else {
      await dbExec(db, 'BEGIN')
      try {
        for (var j = 0; j < entries.length; j++) {
          var applied = entries[j]
          var appliedIntoName = await describePlace(db, applied.into)
          var changes = await applyEntry(db, applied)
          totalRelabeled += changes
          console.log(entryLabel(applied, appliedIntoName) + ': relabeled ' + changes + ' cell(s)')
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

  if (options.verify) {
    await verifyEntries(databasePath, entries, options.skipUnresolvable)
  }
}

module.exports = {
  parseArgs: parseArgs,
  usage: usage,
  collectCurationFiles: collectCurationFiles,
  validateCurationDocument: validateCurationDocument
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err.message || err)
    process.exit(1)
  })
}
