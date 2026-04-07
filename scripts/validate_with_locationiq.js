#!/usr/bin/env node
"use strict";

const fs = require('fs')
const path = require('path')
const https = require('https')
const sqlite3 = require('sqlite3')

const createGeocoder = require('../src/index')
const geohash = require('../src/geohash')

function usage() {
  return [
    'Usage: node scripts/validate_with_locationiq.js --database <geocoder.sqlite> [options]',
    '',
    'Options:',
    '  --database <path>              Geocoder SQLite database to validate (required)',
    '  --api-key <key>                LocationIQ API key (or env LOCATIONIQ_API_KEY)',
    '  --samples <n>                  Number of sample points to evaluate (default: 200)',
    '  --seed <int>                   RNG seed for repeatable sample generation (default: 1337)',
    '  --rps <n>                      Max LocationIQ requests per second when uncached (default: 1)',
    '  --force-refresh <bool>         Ignore cached LocationIQ responses (default: false)',
    '  --reverse-mode <mode>          centroid|boundary (default: boundary)',
    '  --base-precision <n>           Boundary lookup base precision (default: 4)',
    '  --max-precision <n>            Boundary lookup max precision (default: 7)',
    '  --endpoint <url>               LocationIQ reverse endpoint (default: https://us1.locationiq.com/v1/reverse)',
    '  --export-csv <path>            Optional CSV export of the evaluated sample rows',
    '  --help, -h                     Show this help message',
    '',
    'Example:',
    '  LOCATIONIQ_API_KEY=... node scripts/validate_with_locationiq.js \\',
    '    --database tmp/wof-fr-it-compact-p5-d3-pop10k-region.sqlite \\',
    '    --samples 300 \\',
    '    --export-csv tmp/locationiq-validation-fr-it.csv'
  ].join('\n')
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  var normalized = String(value).toLowerCase().trim()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'n') {
    return false
  }
  return defaultValue
}

function parseArgs(argv) {
  var opts = {
    database: null,
    apiKey: process.env.LOCATIONIQ_API_KEY || '',
    cacheDb: null,
    samples: 200,
    seed: 1337,
    rps: 1,
    forceRefresh: false,
    reverseMode: 'boundary',
    basePrecision: 4,
    maxPrecision: 7,
    endpoint: 'https://us1.locationiq.com/v1/reverse',
    exportCsv: null
  }

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]

    if (arg === '--database' || arg === '-d') {
      opts.database = path.resolve(argv[++i])
    } else if (arg === '--api-key') {
      opts.apiKey = String(argv[++i] || '')
    } else if (arg === '--samples') {
      opts.samples = Math.max(1, Math.trunc(Number(argv[++i])))
    } else if (arg === '--seed') {
      opts.seed = Math.trunc(Number(argv[++i]))
    } else if (arg === '--rps') {
      opts.rps = Math.max(0.2, Number(argv[++i]))
    } else if (arg === '--force-refresh') {
      opts.forceRefresh = parseBool(argv[++i], false)
    } else if (arg === '--reverse-mode') {
      opts.reverseMode = String(argv[++i] || 'boundary').toLowerCase()
    } else if (arg === '--base-precision') {
      opts.basePrecision = Math.max(1, Math.trunc(Number(argv[++i])))
    } else if (arg === '--max-precision') {
      opts.maxPrecision = Math.max(opts.basePrecision, Math.trunc(Number(argv[++i])))
    } else if (arg === '--endpoint') {
      opts.endpoint = String(argv[++i] || opts.endpoint)
    } else if (arg === '--export-csv') {
      opts.exportCsv = path.resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new Error('Unknown argument: ' + arg)
    }
  }

  return opts
}

function defaultCachePath(databasePath) {
  var base = path.basename(databasePath)
  if (base.toLowerCase().endsWith('.sqlite')) {
    base = base.slice(0, -7)
  }
  base = base.replace(/[^a-z0-9._-]+/ig, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!base) base = 'geocoder'
  return path.resolve('tmp/locationiq-validation-' + base + '.sqlite')
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms)
  })
}

function mulberry32(seed) {
  var state = seed >>> 0
  return function() {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    var t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dbOpen(dbPath) {
  return new sqlite3.Database(dbPath)
}

function dbExec(db, sql) {
  return new Promise(function(resolve, reject) {
    db.exec(sql, function(err) {
      if (err) reject(err)
      else resolve()
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

function dbGet(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.get(sql, params || [], function(err, row) {
      if (err) reject(err)
      else resolve(row)
    })
  })
}

function dbAll(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(err, rows) {
      if (err) reject(err)
      else resolve(rows || [])
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

async function ensureCacheSchema(cacheDb) {
  await dbExec(cacheDb, `
    CREATE TABLE IF NOT EXISTS sample_points(
      coord_key TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      source_geohash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS locationiq_cache(
      coord_key TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      http_status INTEGER,
      response_json TEXT,
      error_text TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS validation_results(
      coord_key TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      source_geohash TEXT NOT NULL,
      local_name TEXT,
      local_placetype TEXT,
      local_country_id TEXT,
      local_admin1_id TEXT,
      local_json TEXT,
      liq_locality TEXT,
      liq_country_code TEXT,
      liq_display_name TEXT,
      liq_json TEXT,
      locality_match INTEGER NOT NULL DEFAULT 0,
      country_match INTEGER NOT NULL DEFAULT 0,
      policy_match INTEGER NOT NULL DEFAULT 0,
      policy_reason TEXT,
      policy_verdict TEXT NOT NULL DEFAULT 'policy_unset',
      verdict TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

async function ensureValidationColumns(cacheDb) {
  var columns = await dbAll(cacheDb, "PRAGMA table_info(validation_results)")
  var byName = Object.create(null)
  for (var i = 0; i < columns.length; i++) {
    byName[String(columns[i].name)] = true
  }

  var additions = [
    ['local_placetype', 'ALTER TABLE validation_results ADD COLUMN local_placetype TEXT'],
    ['policy_match', 'ALTER TABLE validation_results ADD COLUMN policy_match INTEGER NOT NULL DEFAULT 0'],
    ['policy_reason', 'ALTER TABLE validation_results ADD COLUMN policy_reason TEXT'],
    ['policy_verdict', "ALTER TABLE validation_results ADD COLUMN policy_verdict TEXT NOT NULL DEFAULT 'policy_unset'"]
  ]

  for (var j = 0; j < additions.length; j++) {
    var name = additions[j][0]
    var sql = additions[j][1]
    if (!byName[name]) {
      await dbExec(cacheDb, sql)
    }
  }
}

function hashString32(value) {
  var hash = 2166136261
  var text = String(value || '')
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function deterministicPointInHash(hash, seed, index) {
  var bbox = geohash.decodeBbox(hash)
  var localSeed = (hashString32(hash) ^ hashString32(seed) ^ (index >>> 0)) >>> 0
  var rng = mulberry32(localSeed)
  return {
    latitude: bbox.minLat + (bbox.maxLat - bbox.minLat) * rng(),
    longitude: bbox.minLon + (bbox.maxLon - bbox.minLon) * rng()
  }
}

function deterministicShuffle(items, seed) {
  var rng = mulberry32(seed)
  var list = items.slice()
  for (var i = list.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1))
    var tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list
}

async function detectLookupTable(sourceDb) {
  var rows = await dbAll(
    sourceDb,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('compact_geohash_lookup','place_geohash_lookup')"
  )
  var names = Object.create(null)
  for (var i = 0; i < rows.length; i++) {
    names[rows[i].name] = true
  }
  if (names.compact_geohash_lookup) return 'compact_geohash_lookup'
  if (names.place_geohash_lookup) return 'place_geohash_lookup'
  throw new Error('No geohash lookup table found (expected compact_geohash_lookup or place_geohash_lookup)')
}

async function detectPlacetypeSource(sourceDb) {
  var rows = await dbAll(
    sourceDb,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('compact_places','places')"
  )
  var names = Object.create(null)
  for (var i = 0; i < rows.length; i++) {
    names[rows[i].name] = true
  }
  if (names.compact_places) return 'compact_places'
  if (names.places) return 'places'
  return null
}

async function resolveLocalPlacetype(sourceDb, source, placeId, cache) {
  if (placeId === undefined || placeId === null || placeId === '') {
    return ''
  }
  if (!source) {
    return ''
  }

  var key = String(placeId)
  if (cache[key]) {
    return cache[key]
  }

  var row
  if (source === 'compact_places') {
    row = await dbGet(
      sourceDb,
      `SELECT CASE placetype_code
          WHEN 0 THEN 'locality'
          WHEN 1 THEN 'localadmin'
          WHEN 2 THEN 'region'
          ELSE ''
        END AS placetype
       FROM compact_places
       WHERE id = ?
       LIMIT 1`,
      [placeId]
    )
  } else {
    row = await dbGet(
      sourceDb,
      'SELECT placetype FROM places WHERE id = ? LIMIT 1',
      [placeId]
    )
  }

  var value = row && row.placetype ? String(row.placetype) : ''
  cache[key] = value
  return value
}

function coordKey(latitude, longitude) {
  return Number(latitude).toFixed(6) + ',' + Number(longitude).toFixed(6)
}

async function ensureSamplePoints(sourceDb, cacheDb, lookupTable, targetCount, seed) {
  var countRow = await dbGet(cacheDb, 'SELECT COUNT(*) AS count FROM sample_points')
  var current = countRow ? Number(countRow.count || 0) : 0
  if (current >= targetCount) {
    return
  }

  var geohashRows = await dbAll(
    sourceDb,
    'SELECT geohash FROM ' + lookupTable + ' WHERE geohash IS NOT NULL ORDER BY geohash ASC'
  )
  if (!geohashRows.length) {
    throw new Error('Unable to sample geohashes from ' + lookupTable)
  }

  var geohashes = []
  for (var idx = 0; idx < geohashRows.length; idx++) {
    if (geohashRows[idx].geohash) {
      geohashes.push(geohashRows[idx].geohash)
    }
  }
  geohashes = deterministicShuffle(geohashes, seed)

  var needed = targetCount - current
  var insertedTotal = 0
  for (var i = 0; i < geohashes.length && insertedTotal < needed; i++) {
    var hash = geohashes[i]
    var point = deterministicPointInHash(hash, seed, i)
    var key = coordKey(point.latitude, point.longitude)
    var result = await dbRun(
      cacheDb,
      'INSERT OR IGNORE INTO sample_points(coord_key, latitude, longitude, source_geohash) VALUES (?, ?, ?, ?)',
      [key, point.latitude, point.longitude, hash]
    )
    if (result && result.changes > 0) {
      insertedTotal += 1
    }
  }

  if (current + insertedTotal < targetCount) {
    throw new Error(
      'Could not create enough unique sample points for requested --samples=' + targetCount +
      ' (available=' + (current + insertedTotal) + ')'
    )
  }
}

function normalizeName(value) {
  if (!value) return ''
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function namesMatch(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  if (left.indexOf(right) !== -1 || right.indexOf(left) !== -1) return true
  return false
}

function extractLocationIqLocality(address) {
  if (!address || typeof address !== 'object') return ''
  var keys = [
    'city',
    'town',
    'village',
    'municipality',
    'borough',
    'suburb',
    'county',
    'state_district',
    'state'
  ]
  for (var i = 0; i < keys.length; i++) {
    var value = address[keys[i]]
    if (value) return String(value)
  }
  return ''
}

function matchAddressValue(normalizedLocalName, address, keys) {
  if (!normalizedLocalName || !address || typeof address !== 'object') {
    return null
  }

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var value = address[key]
    if (!value) continue
    if (namesMatch(normalizedLocalName, normalizeName(value))) {
      return { key: key, value: String(value) }
    }
  }

  return null
}

function displayNameMatch(normalizedLocalName, displayName) {
  if (!normalizedLocalName || !displayName) {
    return false
  }

  var segments = String(displayName).split(',')
  for (var i = 0; i < segments.length; i++) {
    if (namesMatch(normalizedLocalName, normalizeName(segments[i]))) {
      return true
    }
  }

  return false
}

function buildPolicyVerdict(params) {
  var countryMatch = Boolean(params.countryMatch)
  var strictLocalityMatch = Boolean(params.strictLocalityMatch)
  var localPlacetype = String(params.localPlacetype || '')
  var localName = String(params.localName || '')
  var normalizedLocalName = normalizeName(localName)
  var liqAddress = params.liqAddress || {}
  var liqDisplayName = String(params.liqDisplayName || '')

  if (!countryMatch) {
    return {
      match: false,
      reason: 'country_mismatch',
      verdict: 'policy_country_mismatch'
    }
  }

  if (!normalizedLocalName) {
    return {
      match: false,
      reason: 'missing_local_name',
      verdict: 'policy_missing_local_name'
    }
  }

  if (strictLocalityMatch) {
    return {
      match: true,
      reason: 'strict_locality',
      verdict: 'policy_match_strict'
    }
  }

  var majorKeys = ['city', 'town', 'municipality', 'county', 'state_district', 'state', 'region', 'province']
  var majorMatch = matchAddressValue(normalizedLocalName, liqAddress, majorKeys)
  if (majorMatch) {
    return {
      match: true,
      reason: 'major_' + majorMatch.key,
      verdict: localPlacetype === 'region' ? 'policy_match_region_rollup' : 'policy_match_major_admin'
    }
  }

  var minorKeys = ['village', 'borough', 'suburb', 'hamlet', 'quarter', 'neighbourhood', 'city_district', 'district']
  var minorMatch = matchAddressValue(normalizedLocalName, liqAddress, minorKeys)
  if (minorMatch) {
    return {
      match: true,
      reason: 'minor_' + minorMatch.key,
      verdict: 'policy_match_minor_admin'
    }
  }

  if (displayNameMatch(normalizedLocalName, liqDisplayName)) {
    return {
      match: true,
      reason: 'display_name_segment',
      verdict: localPlacetype === 'region' ? 'policy_match_region_rollup' : 'policy_match_display_name'
    }
  }

  if (localPlacetype === 'region') {
    return {
      match: false,
      reason: 'region_name_not_present',
      verdict: 'policy_region_mismatch'
    }
  }

  return {
    match: false,
    reason: 'no_policy_match',
    verdict: 'policy_mismatch'
  }
}

function buildVerdict(localityMatch, countryMatch, localName, liqLocality) {
  if (localityMatch && countryMatch) return 'match_city_country'
  if (localityMatch) return 'match_city_only'
  if (countryMatch) return 'match_country_only'
  if (!localName && !liqLocality) return 'missing_both_locality'
  if (!localName) return 'missing_local_locality'
  if (!liqLocality) return 'missing_locationiq_locality'
  return 'mismatch'
}

function fetchJson(endpointUrl, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var req = https.get(endpointUrl, function(response) {
      var chunks = []
      response.on('data', function(chunk) { chunks.push(chunk) })
      response.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8')
        try {
          var parsed = JSON.parse(body)
          resolve({ status: response.statusCode || 0, json: parsed, raw: body })
        } catch (err) {
          reject(new Error('Invalid JSON response (' + (response.statusCode || 0) + '): ' + body.slice(0, 200)))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(timeoutMs, function() {
      req.destroy(new Error('Request timed out after ' + timeoutMs + 'ms'))
    })
  })
}

function buildLocationIqUrl(endpoint, apiKey, latitude, longitude) {
  var url = new URL(endpoint)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('lat', String(latitude))
  url.searchParams.set('lon', String(longitude))
  url.searchParams.set('format', 'json')
  url.searchParams.set('normalizecity', '1')
  url.searchParams.set('addressdetails', '1')
  return url.toString()
}

async function getLocationIqResponse(cacheDb, opts, latitude, longitude) {
  var key = coordKey(latitude, longitude)
  if (!opts.forceRefresh) {
    var cached = await dbGet(cacheDb, 'SELECT * FROM locationiq_cache WHERE coord_key = ?', [key])
    if (cached && cached.response_json) {
      return {
        status: Number(cached.http_status || 0),
        json: JSON.parse(cached.response_json),
        fromCache: true
      }
    }
  }

  var url = buildLocationIqUrl(opts.endpoint, opts.apiKey, latitude, longitude)
  var fetchedAt = new Date().toISOString()
  try {
    var response = await fetchJson(url, 20000)
    await dbRun(
      cacheDb,
      `INSERT INTO locationiq_cache(coord_key, latitude, longitude, http_status, response_json, error_text, fetched_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(coord_key) DO UPDATE SET
         latitude=excluded.latitude,
         longitude=excluded.longitude,
         http_status=excluded.http_status,
         response_json=excluded.response_json,
         error_text=NULL,
         fetched_at=excluded.fetched_at`,
      [key, latitude, longitude, response.status, JSON.stringify(response.json), fetchedAt]
    )
    return {
      status: response.status,
      json: response.json,
      fromCache: false
    }
  } catch (err) {
    await dbRun(
      cacheDb,
      `INSERT INTO locationiq_cache(coord_key, latitude, longitude, http_status, response_json, error_text, fetched_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(coord_key) DO UPDATE SET
         latitude=excluded.latitude,
         longitude=excluded.longitude,
         http_status=NULL,
         response_json=NULL,
         error_text=excluded.error_text,
         fetched_at=excluded.fetched_at`,
      [key, latitude, longitude, String(err && err.message ? err.message : err), fetchedAt]
    )
    throw err
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  var text = String(value)
  if (text.indexOf('"') !== -1 || text.indexOf(',') !== -1 || text.indexOf('\n') !== -1) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

async function writeCsv(cacheDb, csvPath, limit) {
  var rows = await dbAll(
    cacheDb,
    `SELECT coord_key, latitude, longitude, source_geohash, local_name, local_placetype, local_country_id, liq_locality, liq_country_code, verdict, policy_verdict, policy_reason
     FROM validation_results
     ORDER BY updated_at DESC
     LIMIT ?`,
    [limit]
  )

  var headers = [
    'coord_key',
    'latitude',
    'longitude',
    'source_geohash',
    'local_name',
    'local_placetype',
    'local_country_id',
    'liq_locality',
    'liq_country_code',
    'verdict',
    'policy_verdict',
    'policy_reason'
  ]

  var lines = [headers.join(',')]
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    lines.push(headers.map(function(key) { return csvEscape(row[key]) }).join(','))
  }

  fs.mkdirSync(path.dirname(csvPath), { recursive: true })
  fs.writeFileSync(csvPath, lines.join('\n') + '\n', 'utf8')
}

async function main() {
  var opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(usage())
    process.exit(0)
  }

  if (!opts.database) {
    throw new Error('Missing required --database')
  }
  if (!fs.existsSync(opts.database)) {
    throw new Error('Database not found: ' + opts.database)
  }
  if (!opts.apiKey) {
    throw new Error('Missing LocationIQ API key (--api-key or LOCATIONIQ_API_KEY)')
  }
  if (!Number.isFinite(opts.samples) || opts.samples <= 0) {
    throw new Error('--samples must be > 0')
  }
  opts.cacheDb = defaultCachePath(opts.database)

  fs.mkdirSync(path.dirname(opts.cacheDb), { recursive: true })

  var sourceDb = dbOpen(opts.database)
  var cacheDb = dbOpen(opts.cacheDb)
  var geocoder = createGeocoder({
    database: opts.database,
    reverseMode: opts.reverseMode === 'centroid' ? 'centroid' : 'boundary',
    boundary: {
      basePrecision: opts.basePrecision,
      maxPrecision: opts.maxPrecision
    }
  })

  try {
    await ensureCacheSchema(cacheDb)
    await ensureValidationColumns(cacheDb)
    var lookupTable = await detectLookupTable(sourceDb)
    var placetypeSource = await detectPlacetypeSource(sourceDb)
    var placetypeCache = Object.create(null)
    await ensureSamplePoints(sourceDb, cacheDb, lookupTable, opts.samples, Number.isFinite(opts.seed) ? opts.seed : 1337)

    var points = await dbAll(
      cacheDb,
      'SELECT coord_key, latitude, longitude, source_geohash FROM sample_points ORDER BY created_at ASC, coord_key ASC LIMIT ?',
      [opts.samples]
    )

    var uncachedCalls = 0
    var delayMs = Math.ceil(1000 / opts.rps)

    for (var i = 0; i < points.length; i++) {
      var point = points[i]

      var localResult = await geocoder.reverse(point.latitude, point.longitude)
      if (!localResult) localResult = {}

      var liqResult = await getLocationIqResponse(cacheDb, opts, point.latitude, point.longitude)
      if (!liqResult.fromCache) {
        uncachedCalls += 1
      }

      var liqAddress = (liqResult.json && liqResult.json.address) || {}
      var liqLocality = extractLocationIqLocality(liqAddress)
      var liqCountryCode = liqAddress.country_code ? String(liqAddress.country_code).toUpperCase() : ''
      var liqDisplayName = liqResult.json && liqResult.json.display_name ? String(liqResult.json.display_name) : ''

      var localName = localResult.name || ''
      var localCountryId = (localResult.country && localResult.country.id) ? String(localResult.country.id).toUpperCase() : ''
      var localPlacetype = await resolveLocalPlacetype(sourceDb, placetypeSource, localResult.id, placetypeCache)
      var localityMatch = namesMatch(normalizeName(localName), normalizeName(liqLocality))
      var countryMatch = Boolean(localCountryId && liqCountryCode && localCountryId === liqCountryCode)
      var verdict = buildVerdict(localityMatch, countryMatch, localName, liqLocality)
      var policyVerdict = buildPolicyVerdict({
        countryMatch: countryMatch,
        strictLocalityMatch: localityMatch,
        localPlacetype: localPlacetype,
        localName: localName,
        liqAddress: liqAddress,
        liqDisplayName: liqDisplayName
      })

      await dbRun(
        cacheDb,
        `INSERT INTO validation_results(
          coord_key, latitude, longitude, source_geohash,
          local_name, local_placetype, local_country_id, local_admin1_id, local_json,
          liq_locality, liq_country_code, liq_display_name, liq_json,
          locality_match, country_match, policy_match, policy_reason, policy_verdict, verdict, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(coord_key) DO UPDATE SET
          latitude=excluded.latitude,
          longitude=excluded.longitude,
          source_geohash=excluded.source_geohash,
          local_name=excluded.local_name,
          local_placetype=excluded.local_placetype,
          local_country_id=excluded.local_country_id,
          local_admin1_id=excluded.local_admin1_id,
          local_json=excluded.local_json,
          liq_locality=excluded.liq_locality,
          liq_country_code=excluded.liq_country_code,
          liq_display_name=excluded.liq_display_name,
          liq_json=excluded.liq_json,
          locality_match=excluded.locality_match,
          country_match=excluded.country_match,
          policy_match=excluded.policy_match,
          policy_reason=excluded.policy_reason,
          policy_verdict=excluded.policy_verdict,
          verdict=excluded.verdict,
          updated_at=excluded.updated_at`,
        [
          point.coord_key,
          point.latitude,
          point.longitude,
          point.source_geohash,
          localName || null,
          localPlacetype || null,
          localCountryId || null,
          (localResult.admin1 && localResult.admin1.id) ? String(localResult.admin1.id) : null,
          JSON.stringify(localResult),
          liqLocality || null,
          liqCountryCode || null,
          liqDisplayName || null,
          JSON.stringify(liqResult.json),
          localityMatch ? 1 : 0,
          countryMatch ? 1 : 0,
          policyVerdict.match ? 1 : 0,
          policyVerdict.reason || null,
          policyVerdict.verdict || 'policy_unset',
          verdict
        ]
      )

      if (!liqResult.fromCache && i < points.length - 1 && delayMs > 0) {
        await sleep(delayMs)
      }
    }

    var verdictRows = await dbAll(
      cacheDb,
      `SELECT verdict, COUNT(*) AS count
       FROM validation_results
       WHERE coord_key IN (SELECT coord_key FROM sample_points ORDER BY created_at ASC, coord_key ASC LIMIT ?)
       GROUP BY verdict
       ORDER BY count DESC, verdict ASC`,
      [opts.samples]
    )

    var policyVerdictRows = await dbAll(
      cacheDb,
      `SELECT policy_verdict, COUNT(*) AS count
       FROM validation_results
       WHERE coord_key IN (SELECT coord_key FROM sample_points ORDER BY created_at ASC, coord_key ASC LIMIT ?)
       GROUP BY policy_verdict
       ORDER BY count DESC, policy_verdict ASC`,
      [opts.samples]
    )

    var totalRow = await dbGet(
      cacheDb,
      `SELECT COUNT(*) AS count
       FROM validation_results
       WHERE coord_key IN (SELECT coord_key FROM sample_points ORDER BY created_at ASC, coord_key ASC LIMIT ?)`,
      [opts.samples]
    )
    var policyMatchRow = await dbGet(
      cacheDb,
      `SELECT COUNT(*) AS count
       FROM validation_results
       WHERE policy_match = 1
         AND coord_key IN (SELECT coord_key FROM sample_points ORDER BY created_at ASC, coord_key ASC LIMIT ?)`,
      [opts.samples]
    )
    var totalCount = Number(totalRow && totalRow.count ? totalRow.count : 0)
    var policyMatchCount = Number(policyMatchRow && policyMatchRow.count ? policyMatchRow.count : 0)
    var policyRatePct = totalCount > 0 ? ((policyMatchCount * 100) / totalCount) : 0

    console.log('Validation complete')
    console.log('Geocoder DB: ' + opts.database)
    console.log('Cache DB: ' + opts.cacheDb)
    console.log('Samples evaluated: ' + totalCount)
    console.log('LocationIQ uncached calls this run: ' + uncachedCalls)
    console.log('Policy match rate: ' + policyMatchCount + '/' + totalCount + ' (' + policyRatePct.toFixed(1) + '%)')
    console.log('Policy verdict distribution:')
    for (var k = 0; k < policyVerdictRows.length; k++) {
      console.log('  ' + policyVerdictRows[k].policy_verdict + ': ' + policyVerdictRows[k].count)
    }
    console.log('Verdict distribution:')
    for (var j = 0; j < verdictRows.length; j++) {
      console.log('  ' + verdictRows[j].verdict + ': ' + verdictRows[j].count)
    }

    if (opts.exportCsv) {
      await writeCsv(cacheDb, opts.exportCsv, opts.samples)
      console.log('CSV export: ' + opts.exportCsv)
    }
  } finally {
    if (geocoder && geocoder.db && typeof geocoder.db.close === 'function') {
      await new Promise(function(resolve) {
        geocoder.db.close(function() { resolve() })
      })
    }
    await dbClose(sourceDb)
    await dbClose(cacheDb)
  }
}

main().catch(function(err) {
  console.error(err.message || err)
  process.exit(1)
})
