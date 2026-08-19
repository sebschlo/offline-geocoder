#!/usr/bin/env node
"use strict";

const fs = require('fs')
const path = require('path')
const https = require('https')

const createGeocoder = require('../src/index')
const geohash = require('../src/geohash')

function usage() {
  return [
    'Usage:',
    '  node scripts/validate_with_locationiq.js [legacy options]   Random-sample validation of one database (options below)',
    '  node scripts/validate_with_locationiq.js sample [options]   Build a world points file from a GeoNames-style TSV',
    '  node scripts/validate_with_locationiq.js sweep [options]    Quota-aware, resumable world validation sweep',
    '',
    'Run `sample --help` or `sweep --help` for the subcommand options.',
    '',
    'Legacy options:',
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

function requireNumericArg(flag, raw) {
  var value = Number(raw)
  if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isFinite(value)) {
    throw new Error(flag + ' requires a numeric value, got: ' + (raw === undefined ? '(missing)' : raw))
  }
  return value
}

function requireValueArg(flag, raw) {
  // A following option token means the value was accidentally omitted;
  // consuming it would silently change behavior (e.g. --accept-language
  // swallowing --dry-run turns a cache-only command into a network run).
  if (raw === undefined || (typeof raw === 'string' && raw.slice(0, 2) === '--')) {
    throw new Error(flag + ' requires a value, got: ' + (raw === undefined ? '(missing)' : raw))
  }
  return String(raw)
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
  // Lazy so TSV-only commands (sample) work when the optional sqlite3 peer
  // dependency is not installed.
  var sqlite3 = require('sqlite3')
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

var LATIN_BASE_RE = /\p{Script=Latin}/u

function normalizeName(value) {
  if (!value) return ''

  // Strip only marks that are optional spelling variants, and only where
  // they are optional. Combining diacritics (U+0300-U+036F) are dropped
  // solely when they modify a Latin base letter (e vs \u00e9): the same block
  // spells essential letters in other scripts (Cyrillic \u0438 + breve = \u0439), so
  // stripping them unconditionally would collapse distinct names. Hebrew
  // niqqud/cantillation (U+0591-U+05C7) and the Arabic harakat proper
  // (U+064B-U+0652 plus U+0670 superscript alef) are optional vocalization
  // regardless of position. Maddah and hamza marks (U+0653-U+0655) are NOT
  // stripped: NFKD decomposes alef/waw/yeh-hamza letters into base + one of
  // these marks, so removing them would collapse distinct letters. All other
  // marks (e.g. Devanagari vowel signs) are preserved via \p{M} below.
  var decomposed = String(value).normalize('NFKD')
  var kept = ''
  var lastBaseIsLatin = false
  for (var ch of decomposed) {
    var code = ch.codePointAt(0)
    if (code >= 0x0300 && code <= 0x036f) {
      if (!lastBaseIsLatin) kept += ch
      continue
    }
    // Hebrew: strip only the actual combining marks (cantillation, niqqud,
    // rafe, shin/sin dots, upper/lower dots, qamats qatan). Punctuation in
    // the same block — maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun
    // hafukha U+05C6 — must survive to the separator normalization below,
    // or hyphenated names would glue together into a different word.
    var isHebrewOptionalMark = (code >= 0x0591 && code <= 0x05bd) || code === 0x05bf ||
      code === 0x05c1 || code === 0x05c2 || code === 0x05c4 || code === 0x05c5 || code === 0x05c7
    var isArabicHarakat = (code >= 0x064b && code <= 0x0652) || code === 0x0670
    if (isHebrewOptionalMark || isArabicHarakat) {
      continue
    }
    kept += ch
    // Script-based, not ASCII-based: letters like ø or đ are Latin bases
    // that never decompose themselves, yet their accented forms do (ǿ is
    // ø + U+0301 under NFKD) and must fold the same way as e/é.
    lastBaseIsLatin = LATIN_BASE_RE.test(ch)
  }

  return kept
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function tokensContain(container, contained) {
  var containerTokens = container.split(' ')
  var containedTokens = contained.split(' ')
  if (!containedTokens.length || containedTokens.length > containerTokens.length) {
    return false
  }
  for (var start = 0; start + containedTokens.length <= containerTokens.length; start++) {
    var matched = true
    for (var i = 0; i < containedTokens.length; i++) {
      if (containerTokens[start + i] !== containedTokens[i]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

function namesMatch(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  // Containment must respect token boundaries: a short name that is merely
  // a substring of an unrelated word ("ham" inside "hamme") is not
  // agreement, while "salvador" inside "san salvador" still matches as a
  // whole-token qualifier relationship.
  return tokensContain(left, right) || tokensContain(right, left)
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

function buildLocationIqUrl(endpoint, apiKey, latitude, longitude, acceptLanguage) {
  var url = new URL(endpoint)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('lat', String(latitude))
  url.searchParams.set('lon', String(longitude))
  url.searchParams.set('format', 'json')
  url.searchParams.set('normalizecity', '1')
  url.searchParams.set('addressdetails', '1')
  if (acceptLanguage) {
    url.searchParams.set('accept-language', acceptLanguage)
  }
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

// ---------------------------------------------------------------------------
// World validation sweep (subcommands: sample, sweep)
//
// `sample` turns a GeoNames-style TSV (cities1000 format) into a JSONL points
// file with the top-N most populous places per country. `sweep` reverse
// geocodes every point with LocationIQ (JSONL response cache, persisted UTC
// daily request cap) and compares the answers against the offline geocoder,
// ranking countries by mismatch rate in a Markdown report.
// ---------------------------------------------------------------------------

var SWEEP_CACHE_DECIMALS = 4
var SWEEP_TIMEOUT_MS = 20000
var SWEEP_DEFAULT_WORKDIR = 'tmp/locationiq-sweep'
// The quota state deliberately lives OUTSIDE the workdir: separate workdirs
// per endpoint/language configuration must still share one daily cap,
// because they all spend requests against the same API key.
var SWEEP_DEFAULT_STATE_PATH = 'tmp/locationiq-quota.json'
// Fixed seed for the sampler's country-order shuffle: stable across runs, but
// not alphabetical, so a small --max-points does not bias the world sample
// toward alphabetically-early country codes.
var SWEEP_SAMPLE_SHUFFLE_SEED = 1729
var SWEEP_SEVERITY = {
  country_mismatch: 3,
  offline_empty: 2,
  name_mismatch: 1
}

var LIQ_LOCALITY_KEYS = ['city', 'town', 'village', 'municipality', 'hamlet', 'borough', 'suburb', 'city_district', 'district', 'quarter', 'neighbourhood']
var LIQ_COUNTY_KEYS = ['county', 'state_district']
var LIQ_STATE_KEYS = ['state', 'region', 'province']

function sampleUsage() {
  return [
    'Usage: node scripts/validate_with_locationiq.js sample --geonames <places.tsv> [options]',
    '',
    'Builds a JSONL points file ({lat, lon, country, name, population} per line)',
    'from a GeoNames-style TSV (the cities1000 format: tab separated, feature',
    'class in column 7, country code in column 9, population in column 15).',
    'Rows whose feature class is not P are skipped. No data file is committed to',
    'the repository; download e.g. cities1000.zip from download.geonames.org.',
    '',
    'Options:',
    '  --geonames <path>    GeoNames-style TSV input (required)',
    '  --out <path>         Output JSONL points file (default: ' + SWEEP_DEFAULT_WORKDIR + '/points.jsonl)',
    '  --per-country <n>    Places per country, most populous first (default: 25)',
    '  --max-points <n>     Optional total cap, filled round-robin by rank over a deterministically',
    '                       shuffled country order; a cap below the country count leaves some',
    '                       countries out (an unbiased subset — a warning reports how many)',
    '  --help, -h           Show this help message'
  ].join('\n')
}

function sweepUsage() {
  return [
    'Usage: node scripts/validate_with_locationiq.js sweep --points <points.jsonl> --database <geocoder.sqlite> [options]',
    '',
    'Reverse geocodes every point with LocationIQ and compares the answer to the',
    'offline geocoder. Every LocationIQ response is cached (JSONL, keyed by',
    'coordinates rounded to ' + SWEEP_CACHE_DECIMALS + ' decimals); cached points are never re-queried, so',
    're-running the same command resumes where the previous run stopped. A state',
    'file records the UTC date and request count, so multiple runs on the same',
    'UTC day share one daily cap. On HTTP 429 the run backs off and stops',
    'cleanly. Designed for LocationIQ\'s free tier; run one sweep at a time.',
    'The cache records the endpoint and accept-language it was built with, and',
    'network runs with different values are rejected — use a separate --workdir',
    'per configuration (--dry-run only evaluates the cache and is exempt).',
    '',
    'Options:',
    '  --points <path>          JSONL points file (required; see the sample subcommand)',
    '  --database <path>        Offline geocoder SQLite database (required)',
    '  --workdir <path>         Directory for cache/report files (default: ' + SWEEP_DEFAULT_WORKDIR + ')',
    '  --cache <path>           LocationIQ response cache (default: <workdir>/cache.jsonl)',
    '  --state <path>           Daily quota state file (default: ' + SWEEP_DEFAULT_STATE_PATH + ').',
    '                           Deliberately outside the workdir: all sweep configurations',
    '                           share one daily cap because they spend the same API key.',
    '  --report <path>          Markdown report output (default: <workdir>/report.md)',
    '  --mismatches <path>      Mismatch JSONL output (default: <workdir>/mismatches.jsonl)',
    '  --api-key <key>          LocationIQ API key (or env LOCATIONIQ_API_KEY)',
    '  --daily-cap <n>          Max LocationIQ requests per UTC day, all runs combined (default: 4500)',
    '  --rps <n>                Max LocationIQ requests per second (default: 1)',
    '  --max-requests <n>       Optional per-run request limit (useful for smoke tests)',
    '  --endpoint <url>         LocationIQ reverse endpoint (default: https://us1.locationiq.com/v1/reverse)',
    '  --accept-language <tag>  Accept-language sent to LocationIQ (default: en; empty to disable)',
    '  --reverse-mode <mode>    centroid|boundary (default: boundary)',
    '  --base-precision <n>     Boundary lookup base precision (default: 4)',
    '  --max-precision <n>      Boundary lookup max precision (default: 7)',
    '  --dry-run                No network: evaluate cached responses only and rebuild the report',
    '  --help, -h               Show this help message',
    '',
    'Example:',
    '  node scripts/validate_with_locationiq.js sample --geonames tmp/cities1000.txt --per-country 25',
    '  LOCATIONIQ_API_KEY=... node scripts/validate_with_locationiq.js sweep \\',
    '    --points ' + SWEEP_DEFAULT_WORKDIR + '/points.jsonl --database tmp/world.sqlite',
    '  node scripts/validate_with_locationiq.js sweep \\',
    '    --points ' + SWEEP_DEFAULT_WORKDIR + '/points.jsonl --database tmp/world.sqlite --dry-run'
  ].join('\n')
}

function utcDateString(date) {
  return date.toISOString().slice(0, 10)
}

function sweepCoordKey(latitude, longitude) {
  return Number(latitude).toFixed(SWEEP_CACHE_DECIMALS) + ',' + Number(longitude).toFixed(SWEEP_CACHE_DECIMALS)
}

// --- sample: GeoNames TSV -> points JSONL ----------------------------------

function parseGeonamesLine(line) {
  if (!line || !line.trim()) return null

  var cols = line.split('\t')
  if (cols.length < 15) return null

  var latitude = Number(cols[4])
  var longitude = Number(cols[5])
  var featureClass = String(cols[6] || '').trim()
  var country = String(cols[8] || '').trim().toUpperCase()
  var population = Number(cols[14])

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  if (featureClass !== 'P') return null
  if (!/^[A-Z]{2}$/.test(country)) return null

  return {
    geonameid: Number(cols[0]) || 0,
    name: String(cols[1] || '').trim(),
    lat: latitude,
    lon: longitude,
    country: country,
    population: Number.isFinite(population) && population > 0 ? Math.trunc(population) : 0
  }
}

function selectTopPlaces(rows, perCountry, maxPoints) {
  var byCountry = Object.create(null)
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!byCountry[row.country]) byCountry[row.country] = []
    byCountry[row.country].push(row)
  }

  var countries = Object.keys(byCountry).sort()
  var total = 0
  for (var c = 0; c < countries.length; c++) {
    var list = byCountry[countries[c]]
    list.sort(function(a, b) {
      if (b.population !== a.population) return b.population - a.population
      return a.geonameid - b.geonameid
    })
    byCountry[countries[c]] = list.slice(0, perCountry)
    total += byCountry[countries[c]].length
  }

  var picked = []
  if (maxPoints && total > maxPoints) {
    // Fill round-robin by rank so a total cap trims depth per country instead
    // of dropping whole countries. The per-rank country order is shuffled
    // deterministically: with an alphabetical order, a cap smaller than the
    // country count would always drop the same alphabetically-late countries
    // and systematically bias the world report.
    var order = deterministicShuffle(countries, SWEEP_SAMPLE_SHUFFLE_SEED)
    for (var rank = 0; rank < perCountry && picked.length < maxPoints; rank++) {
      for (var j = 0; j < order.length && picked.length < maxPoints; j++) {
        var ranked = byCountry[order[j]]
        if (rank < ranked.length) picked.push(ranked[rank])
      }
    }
  } else {
    for (var k = 0; k < countries.length; k++) {
      picked = picked.concat(byCountry[countries[k]])
    }
  }

  picked.sort(function(a, b) {
    if (a.country !== b.country) return a.country < b.country ? -1 : 1
    if (b.population !== a.population) return b.population - a.population
    return a.geonameid - b.geonameid
  })

  return picked.map(function(place) {
    return {
      lat: place.lat,
      lon: place.lon,
      country: place.country,
      name: place.name,
      population: place.population
    }
  })
}

function buildSamplePoints(tsvText, perCountry, maxPoints) {
  var lines = String(tsvText).split(/\r?\n/)
  var rows = []
  var skipped = 0
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    var row = parseGeonamesLine(lines[i])
    if (row) rows.push(row)
    else skipped += 1
  }
  var countriesTotal = Object.create(null)
  for (var j = 0; j < rows.length; j++) {
    countriesTotal[rows[j].country] = true
  }

  return {
    points: selectTopPlaces(rows, perCountry, maxPoints),
    parsed: rows.length,
    skipped: skipped,
    countriesTotal: Object.keys(countriesTotal).length
  }
}

function parseSampleArgs(argv) {
  var opts = {
    geonames: null,
    out: path.resolve(SWEEP_DEFAULT_WORKDIR, 'points.jsonl'),
    perCountry: 25,
    maxPoints: null,
    help: false
  }

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]

    if (arg === '--geonames') {
      opts.geonames = path.resolve(requireValueArg('--geonames', argv[++i]))
    } else if (arg === '--out') {
      opts.out = path.resolve(requireValueArg('--out', argv[++i]))
    } else if (arg === '--per-country') {
      opts.perCountry = Math.max(1, Math.trunc(requireNumericArg('--per-country', argv[++i])))
    } else if (arg === '--max-points') {
      var maxPoints = Math.trunc(requireNumericArg('--max-points', argv[++i]))
      if (maxPoints <= 0) {
        throw new Error('--max-points must be > 0, got: ' + maxPoints)
      }
      opts.maxPoints = maxPoints
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new Error('Unknown sample argument: ' + arg)
    }
  }

  return opts
}

async function sampleMain(argv) {
  var opts = parseSampleArgs(argv)
  if (opts.help) {
    console.log(sampleUsage())
    return
  }

  if (!opts.geonames) {
    throw new Error('Missing required --geonames (see `sample --help`)')
  }
  if (!fs.existsSync(opts.geonames)) {
    throw new Error('GeoNames TSV not found: ' + opts.geonames)
  }
  if (!Number.isFinite(opts.perCountry) || opts.perCountry <= 0) {
    throw new Error('--per-country must be > 0')
  }

  var result = buildSamplePoints(fs.readFileSync(opts.geonames, 'utf8'), opts.perCountry, opts.maxPoints)
  if (!result.points.length) {
    throw new Error('No usable rows found in ' + opts.geonames)
  }

  var countries = Object.create(null)
  var lines = []
  for (var i = 0; i < result.points.length; i++) {
    countries[result.points[i].country] = true
    lines.push(JSON.stringify(result.points[i]))
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, lines.join('\n') + '\n', 'utf8')

  var coveredCountries = Object.keys(countries).length
  console.log('Parsed rows: ' + result.parsed + ' (skipped ' + result.skipped + ')')
  console.log('Points written: ' + result.points.length + ' across ' + coveredCountries + ' countries')
  if (coveredCountries < result.countriesTotal) {
    console.log('Warning: --max-points ' + opts.maxPoints + ' is below the country count; only ' +
      coveredCountries + ' of ' + result.countriesTotal + ' countries are included ' +
      '(an unbiased deterministic subset). Increase --max-points for full world coverage.')
  }
  console.log('Points file: ' + opts.out)
}

// --- sweep: cache, quota state, comparison, report -------------------------

function loadPointsFile(pointsPath) {
  var lines = fs.readFileSync(pointsPath, 'utf8').split(/\r?\n/)
  var points = []
  var seen = Object.create(null)
  var skipped = 0
  var duplicates = 0

  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    var row
    try {
      row = JSON.parse(lines[i])
    } catch (err) {
      skipped += 1
      continue
    }

    var lat = Number(row.lat !== undefined ? row.lat : row.latitude)
    var lon = Number(row.lon !== undefined ? row.lon : row.longitude)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      skipped += 1
      continue
    }

    var key = sweepCoordKey(lat, lon)
    if (seen[key]) {
      duplicates += 1
      continue
    }
    seen[key] = true

    points.push({
      key: key,
      lat: lat,
      lon: lon,
      country: row.country ? String(row.country).toUpperCase() : '',
      name: row.name ? String(row.name) : '',
      population: Number(row.population) || 0
    })
  }

  return { points: points, skipped: skipped, duplicates: duplicates }
}

function loadSweepCache(cachePath) {
  var map = Object.create(null)
  if (!fs.existsSync(cachePath)) return map

  var lines = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try {
      var entry = JSON.parse(lines[i])
      if (entry && entry.key) map[entry.key] = entry
    } catch (err) {
      // Ignore torn/corrupt lines (e.g. from an interrupted write); the point
      // will simply be fetched again.
    }
  }
  return map
}

function appendSweepCache(cachePath, entry) {
  // If an interrupted append left a torn final line without a newline,
  // appending directly would glue the new entry onto the fragment, making
  // both unreadable and re-spending a request on that point every run.
  // Start a fresh line whenever the file does not already end with one.
  var prefix = ''
  try {
    var stat = fs.statSync(cachePath)
    if (stat.size > 0) {
      var fd = fs.openSync(cachePath, 'r')
      var lastByte = Buffer.alloc(1)
      try {
        fs.readSync(fd, lastByte, 0, 1, stat.size - 1)
      } finally {
        fs.closeSync(fd)
      }
      if (lastByte.toString('utf8') !== '\n') prefix = '\n'
    }
  } catch (err) {
    // Missing file: the append below creates it.
  }
  fs.appendFileSync(cachePath, prefix + JSON.stringify(entry) + '\n', 'utf8')
}

function readSweepCacheMeta(cachePath) {
  if (!fs.existsSync(cachePath)) return null

  var lines = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try {
      var entry = JSON.parse(lines[i])
      if (entry && entry.meta && typeof entry.meta === 'object') return entry.meta
    } catch (err) {
      // Torn lines are handled by loadSweepCache; skip them here too.
    }
  }
  return null
}

function ensureSweepCacheConfig(cachePath, config) {
  // Cached responses depend on the request-shaping options, so the cache is
  // stamped with them and a run using different options is rejected loudly:
  // silently evaluating stale responses (or silently refetching everything)
  // would corrupt the report or re-spend quota.
  var meta = readSweepCacheMeta(cachePath)
  if (!meta) {
    appendSweepCache(cachePath, { meta: config })
    return
  }
  if (meta.endpoint !== config.endpoint || meta.acceptLanguage !== config.acceptLanguage) {
    throw new Error('Cache ' + cachePath + ' was built with endpoint=' + meta.endpoint +
      ' accept-language=' + (meta.acceptLanguage || '(none)') +
      ', but this run uses endpoint=' + config.endpoint +
      ' accept-language=' + (config.acceptLanguage || '(none)') +
      '. Responses are not comparable across these settings: use a separate --workdir or --cache, or delete the cache to refetch.')
  }
}

function loadQuotaState(statePath, todayUtc) {
  var raw
  try {
    raw = fs.readFileSync(statePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { date: todayUtc, count: 0 }
    }
    throw err
  }

  var parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    parsed = null
  }

  // Fail closed: an existing-but-unreadable state file must not silently
  // reset today's count to zero, or a corrupted file would allow a fresh
  // full daily cap of requests.
  if (!parsed || typeof parsed.date !== 'string' || !Number.isFinite(Number(parsed.count))) {
    throw new Error('Quota state file ' + statePath + ' exists but is unreadable; refusing to guess the request count. ' +
      'Inspect it and, only if you are sure no requests were made today (UTC), delete it to reset.')
  }

  if (parsed.date !== todayUtc) {
    return { date: todayUtc, count: 0 }
  }
  return { date: todayUtc, count: Math.max(0, Math.trunc(Number(parsed.count))) }
}

function saveQuotaState(statePath, state) {
  // Write-then-rename so an interrupted save can never leave a truncated
  // state file behind (which loadQuotaState would refuse to read).
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  var tmpPath = statePath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify({ date: state.date, count: state.count }) + '\n', 'utf8')
  fs.renameSync(tmpPath, statePath)
}

var LIQ_NAME_KEY_GROUPS = [LIQ_LOCALITY_KEYS, LIQ_COUNTY_KEYS, LIQ_STATE_KEYS]

function findLiqNameMatch(normalizedOfflineName, address, displayName) {
  if (!normalizedOfflineName) return null

  for (var g = 0; g < LIQ_NAME_KEY_GROUPS.length; g++) {
    var hit = matchAddressValue(normalizedOfflineName, address, LIQ_NAME_KEY_GROUPS[g])
    if (hit) return hit.key
  }

  if (displayNameMatch(normalizedOfflineName, displayName)) {
    return 'display_name'
  }

  return null
}

function liqHasComparableName(address) {
  if (!address || typeof address !== 'object') return false
  for (var g = 0; g < LIQ_NAME_KEY_GROUPS.length; g++) {
    var keys = LIQ_NAME_KEY_GROUPS[g]
    for (var i = 0; i < keys.length; i++) {
      if (address[keys[i]]) return true
    }
  }
  return false
}

function comparePoint(point, offlineResult, cacheEntry) {
  var body = cacheEntry && cacheEntry.body && typeof cacheEntry.body === 'object' ? cacheEntry.body : null
  var address = body && body.address && typeof body.address === 'object' ? body.address : null
  var liqOk = Boolean(cacheEntry && Number(cacheEntry.status) === 200 && address && !body.error)

  var offlineName = offlineResult && offlineResult.name ? String(offlineResult.name) : ''
  var offlineCountry = offlineResult && offlineResult.country && offlineResult.country.id
    ? String(offlineResult.country.id).toUpperCase()
    : ''

  var record = {
    key: point.key,
    lat: point.lat,
    lon: point.lon,
    country: point.country || '',
    sample_name: point.name || '',
    offline_name: offlineName,
    offline_country: offlineCountry,
    liq_name: '',
    liq_country: '',
    liq_display_name: '',
    verdict: '',
    match_via: ''
  }

  if (liqOk) {
    record.liq_name = extractLocationIqLocality(address)
    record.liq_country = address.country_code ? String(address.country_code).toUpperCase() : ''
    record.liq_display_name = body.display_name ? String(body.display_name) : ''
  }
  if (!record.country) {
    record.country = record.liq_country || offlineCountry || '??'
  }

  if (!liqOk) {
    record.verdict = offlineName ? 'liq_empty' : 'both_empty'
  } else if (!offlineName) {
    record.verdict = 'offline_empty'
  } else if (!offlineCountry || !record.liq_country) {
    // One side lacks a country code, so the severe check cannot run and the
    // point must not inflate agreement either: classify it as unverifiable.
    // Any name match is still recorded in match_via for context.
    record.match_via = findLiqNameMatch(normalizeName(offlineName), address, record.liq_display_name) || ''
    record.verdict = 'country_unknown'
  } else if (offlineCountry !== record.liq_country) {
    record.verdict = 'country_mismatch'
  } else {
    // Attempt the match first: display_name segments count as agreement even
    // when the address block carries no name fields at all.
    var via = findLiqNameMatch(normalizeName(offlineName), address, record.liq_display_name)
    if (via) {
      record.verdict = 'agree'
      record.match_via = via
    } else if (!liqHasComparableName(address)) {
      // Countries agree, but LocationIQ supplied no locality/county/state
      // name to compare against (common for sparse rural responses):
      // unverifiable, not a name mismatch.
      record.verdict = 'liq_name_missing'
    } else {
      record.verdict = 'name_mismatch'
    }
  }

  return record
}

function mdEscape(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/g, '\\|')
}

function formatAnswer(name, country, fallback) {
  if (name) return name + (country ? ' (' + country + ')' : '')
  if (fallback) return fallback.length > 60 ? fallback.slice(0, 57) + '...' : fallback
  return '(no result)'
}

function buildSweepReport(params) {
  var records = params.records || []
  var perCountry = Object.create(null)
  var totals = { agree: 0, country_mismatch: 0, name_mismatch: 0, offline_empty: 0, liq_empty: 0, both_empty: 0, country_unknown: 0, liq_name_missing: 0 }

  for (var i = 0; i < records.length; i++) {
    var record = records[i]
    var bucket = perCountry[record.country]
    if (!bucket) {
      bucket = perCountry[record.country] = {
        country: record.country,
        evaluated: 0,
        agree: 0,
        country_mismatch: 0,
        name_mismatch: 0,
        offline_empty: 0,
        liq_empty: 0,
        both_empty: 0,
        country_unknown: 0,
        liq_name_missing: 0
      }
    }
    bucket.evaluated += 1
    if (bucket[record.verdict] !== undefined) bucket[record.verdict] += 1
    if (totals[record.verdict] !== undefined) totals[record.verdict] += 1
  }

  var countryRows = Object.keys(perCountry).map(function(code) {
    var bucket = perCountry[code]
    bucket.verifiable = bucket.agree + bucket.country_mismatch + bucket.name_mismatch + bucket.offline_empty
    bucket.mismatchRate = bucket.verifiable > 0 ? (bucket.verifiable - bucket.agree) / bucket.verifiable : 0
    return bucket
  })
  countryRows.sort(function(a, b) {
    if (b.mismatchRate !== a.mismatchRate) return b.mismatchRate - a.mismatchRate
    if (b.verifiable !== a.verifiable) return b.verifiable - a.verifiable
    return a.country < b.country ? -1 : (a.country > b.country ? 1 : 0)
  })

  var verifiable = totals.agree + totals.country_mismatch + totals.name_mismatch + totals.offline_empty
  var agreementPct = verifiable > 0 ? (totals.agree * 100) / verifiable : 0

  var worst = records
    .filter(function(record) { return SWEEP_SEVERITY[record.verdict] })
    .sort(function(a, b) {
      var severity = (SWEEP_SEVERITY[b.verdict] || 0) - (SWEEP_SEVERITY[a.verdict] || 0)
      if (severity !== 0) return severity
      if (a.country !== b.country) return a.country < b.country ? -1 : 1
      return a.key < b.key ? -1 : 1
    })
    .slice(0, 10)

  var lines = []
  lines.push('# LocationIQ world validation sweep')
  lines.push('')
  lines.push('- Generated: ' + params.generatedAt)
  lines.push('- Offline database: `' + params.databaseLabel + '`')
  lines.push('- Points file: `' + params.pointsPath + '` (' + params.totalPoints + ' points; ' +
    records.length + ' evaluated, ' + params.unfetched + ' awaiting fetch)')
  lines.push('- Verifiable points: ' + verifiable + ' — agreement ' + totals.agree + '/' + verifiable +
    ' (' + agreementPct.toFixed(1) + '%)')
  lines.push('- Mismatches: ' + (verifiable - totals.agree) + ' (country ' + totals.country_mismatch +
    ', name ' + totals.name_mismatch + ', offline empty ' + totals.offline_empty + ')')
  lines.push('- Unverifiable: ' + (totals.liq_empty + totals.both_empty + totals.country_unknown + totals.liq_name_missing) +
    ' (LocationIQ empty ' + totals.liq_empty + ', no name ' + totals.liq_name_missing +
    ', both empty ' + totals.both_empty +
    ', country unknown ' + totals.country_unknown + ')')
  var quotaCount = params.quota && params.quota.count !== null && params.quota.count !== undefined &&
    Number.isFinite(Number(params.quota.count)) ? Number(params.quota.count) : null
  lines.push('- Requests used on ' + params.quota.date + ' (UTC): ' +
    (quotaCount === null ? 'unknown (quota state unreadable)' : quotaCount + '/' + params.dailyCap))
  if (params.stopReason) {
    lines.push('- Run stopped early: ' + params.stopReason + (params.stopDetail ? ' (' + params.stopDetail + ')' : ''))
  }
  lines.push('')
  lines.push('## Countries ranked by mismatch rate (worst first)')
  lines.push('')
  lines.push('| Country | Points | Verifiable | Agreement | Country mismatch | Name mismatch | Offline empty | LIQ empty | LIQ no name | Country unknown |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (var c = 0; c < countryRows.length; c++) {
    var row = countryRows[c]
    var pct = row.verifiable > 0 ? ((row.agree * 100) / row.verifiable).toFixed(1) + '%' : '-'
    lines.push('| ' + mdEscape(row.country) + ' | ' + row.evaluated + ' | ' + row.verifiable + ' | ' + pct +
      ' | ' + row.country_mismatch + ' | ' + row.name_mismatch + ' | ' + row.offline_empty + ' | ' + row.liq_empty +
      ' | ' + row.liq_name_missing + ' | ' + row.country_unknown + ' |')
  }
  lines.push('')
  lines.push('## Worst examples')
  lines.push('')
  if (worst.length) {
    lines.push('| Lat | Lon | Sampled place | Offline answer | LocationIQ answer | Verdict |')
    lines.push('| ---: | ---: | --- | --- | --- | --- |')
    for (var w = 0; w < worst.length; w++) {
      var bad = worst[w]
      lines.push('| ' + bad.lat + ' | ' + bad.lon +
        ' | ' + mdEscape(formatAnswer(bad.sample_name, bad.country)) +
        ' | ' + mdEscape(formatAnswer(bad.offline_name, bad.offline_country)) +
        ' | ' + mdEscape(formatAnswer(bad.liq_name, bad.liq_country, bad.liq_display_name)) +
        ' | ' + bad.verdict + ' |')
    }
  } else {
    lines.push('No mismatches recorded.')
  }
  lines.push('')
  lines.push('## Verdicts')
  lines.push('')
  lines.push('- `agree`: countries match and the offline name matches a LocationIQ locality/county/state field (or a display-name segment) after case/diacritics-insensitive normalization')
  lines.push('- `country_mismatch` (severe): the two geocoders disagree on the country')
  lines.push('- `name_mismatch`: countries match but no LocationIQ field matches the offline name')
  lines.push('- `offline_empty`: LocationIQ answered but the offline geocoder returned nothing')
  lines.push('- `liq_empty` / `both_empty`: LocationIQ had no answer — excluded from agreement figures')
  lines.push('- `country_unknown`: one side answered without a country code, so the comparison cannot be verified — excluded from agreement figures (a name match, if any, is noted in `match_via`)')
  lines.push('- `liq_name_missing`: countries agree but LocationIQ returned no locality/county/state name to compare against — excluded from agreement figures')
  lines.push('')
  return lines.join('\n')
}

function writeSweepMismatches(mismatchesPath, records) {
  var lines = []
  for (var i = 0; i < records.length; i++) {
    if (SWEEP_SEVERITY[records[i].verdict]) {
      lines.push(JSON.stringify(records[i]))
    }
  }
  fs.mkdirSync(path.dirname(mismatchesPath), { recursive: true })
  fs.writeFileSync(mismatchesPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
  return lines.length
}

async function runSweep(opts, deps) {
  var log = (deps && deps.log) || console.log
  var sleepImpl = (deps && deps.sleep) || sleep
  var nowImpl = (deps && deps.now) || function() { return new Date() }

  if (!deps || typeof deps.fetchJson !== 'function') throw new Error('runSweep requires deps.fetchJson')
  if (typeof deps.reverse !== 'function') throw new Error('runSweep requires deps.reverse')

  // Guard the quota knobs: a NaN cap would make every comparison false and
  // silently disable the daily limit.
  if (!Number.isFinite(opts.dailyCap) || opts.dailyCap < 0) {
    throw new Error('dailyCap must be a finite number >= 0, got: ' + opts.dailyCap)
  }
  if (!Number.isFinite(opts.rps) || opts.rps <= 0) {
    throw new Error('rps must be a finite number > 0, got: ' + opts.rps)
  }
  if (opts.maxRequests !== null && opts.maxRequests !== undefined &&
      (!Number.isFinite(opts.maxRequests) || opts.maxRequests < 0)) {
    throw new Error('maxRequests must be a finite number >= 0 when set, got: ' + opts.maxRequests)
  }

  var loaded = loadPointsFile(opts.pointsPath)
  var points = loaded.points
  if (!points.length) {
    throw new Error('No usable points in ' + opts.pointsPath)
  }
  if (loaded.skipped || loaded.duplicates) {
    log('Points file: skipped ' + loaded.skipped + ' invalid and ' + loaded.duplicates + ' duplicate rows')
  }

  fs.mkdirSync(path.dirname(opts.cachePath), { recursive: true })
  if (!opts.dryRun) {
    // Dry runs only evaluate what is already cached, so the request-shaping
    // options are irrelevant there; network runs must match the cache.
    ensureSweepCacheConfig(opts.cachePath, { endpoint: opts.endpoint, acceptLanguage: opts.acceptLanguage })
  }
  var cache = loadSweepCache(opts.cachePath)
  var todayUtc = utcDateString(nowImpl())
  var state
  try {
    state = loadQuotaState(opts.statePath, todayUtc)
  } catch (err) {
    if (!opts.dryRun) throw err
    // A dry run makes no requests, so an unreadable quota file must not
    // block inspecting the cache. Leave the file untouched for inspection
    // and report the day's usage as unknown.
    state = { date: todayUtc, count: null }
    log('Warning: ' + String(err && err.message ? err.message : err))
    log('Continuing anyway: --dry-run makes no requests and leaves the quota state untouched.')
  }

  var stopReason = null
  var stopDetail = ''
  var requestsThisRun = 0
  var delayMs = Math.ceil(1000 / (opts.rps > 0 ? opts.rps : 1))
  var lastRequestAt = 0

  if (!opts.dryRun) {
    for (var i = 0; i < points.length; i++) {
      var point = points[i]
      if (cache[point.key]) continue

      if (opts.maxRequests !== null && opts.maxRequests !== undefined && requestsThisRun >= opts.maxRequests) {
        stopReason = 'max_requests'
        break
      }

      var waitMs = lastRequestAt + delayMs - Date.now()
      if (waitMs > 0) await sleepImpl(waitMs)

      // A long run can cross midnight UTC — including during the rate-limit
      // wait just above, so the day is derived only after it. Roll the state
      // over so the request counts against the day it is actually made in;
      // otherwise a later invocation would reset the stale date and allow
      // nearly twice the cap within the new UTC day.
      var attemptDate = utcDateString(nowImpl())
      if (attemptDate !== state.date) {
        state = { date: attemptDate, count: 0 }
        saveQuotaState(opts.statePath, state)
      }

      if (state.count >= opts.dailyCap) {
        stopReason = 'daily_cap'
        break
      }

      // Count the attempt before it happens so a crash mid-request can only
      // over-count, never let a later run exceed the cap.
      state.count += 1
      saveQuotaState(opts.statePath, state)
      requestsThisRun += 1
      lastRequestAt = Date.now()

      var url = buildLocationIqUrl(opts.endpoint, opts.apiKey, point.lat, point.lon, opts.acceptLanguage)
      var response
      try {
        response = await deps.fetchJson(url, SWEEP_TIMEOUT_MS)
      } catch (err) {
        stopReason = 'fetch_error'
        stopDetail = String(err && err.message ? err.message : err)
        break
      }

      var status = Number(response && response.status)
      if (status === 200 || status === 404) {
        // 200 is an answer and 404 is LocationIQ's definitive, coordinate-
        // specific "unable to geocode" (e.g. open ocean) — both cacheable so
        // they are never asked again.
        var entry = {
          key: point.key,
          lat: point.lat,
          lon: point.lon,
          status: status,
          body: response.json,
          fetched_at: new Date().toISOString()
        }
        appendSweepCache(opts.cachePath, entry)
        cache[point.key] = entry
      } else if (status === 400) {
        // A rejected request shape is a configuration problem, not a fact
        // about the coordinates (the points loader already validates ranges).
        // Caching it or continuing would burn the daily allowance on a
        // systematically broken request: stop, and cache nothing.
        stopReason = 'bad_request'
        stopDetail = 'HTTP 400'
        break
      } else if (status === 401 || status === 403) {
        stopReason = 'auth_error'
        stopDetail = 'HTTP ' + status
        break
      } else if (status === 429) {
        stopReason = 'rate_limited'
        stopDetail = 'HTTP 429'
        break
      } else {
        stopReason = 'server_error'
        stopDetail = 'HTTP ' + status
        break
      }
    }
  }

  var records = []
  var verdictCounts = Object.create(null)
  var unfetched = 0
  for (var j = 0; j < points.length; j++) {
    var entryForPoint = cache[points[j].key]
    if (!entryForPoint) {
      unfetched += 1
      continue
    }
    var offlineResult = await deps.reverse(points[j].lat, points[j].lon)
    var record = comparePoint(points[j], offlineResult || null, entryForPoint)
    verdictCounts[record.verdict] = (verdictCounts[record.verdict] || 0) + 1
    records.push(record)
  }

  var report = buildSweepReport({
    generatedAt: new Date().toISOString(),
    databaseLabel: opts.databaseLabel,
    pointsPath: opts.pointsPath,
    totalPoints: points.length,
    unfetched: unfetched,
    records: records,
    quota: state,
    dailyCap: opts.dailyCap,
    stopReason: stopReason,
    stopDetail: stopDetail
  })
  fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true })
  fs.writeFileSync(opts.reportPath, report, 'utf8')
  var mismatchCount = writeSweepMismatches(opts.mismatchesPath, records)

  log('Points: ' + points.length + ' total, ' + records.length + ' evaluated, ' + unfetched + ' awaiting fetch')
  log('LocationIQ requests this run: ' + requestsThisRun + ' (today ' + state.date + ' UTC: ' +
    (state.count === null ? 'unknown' : state.count + '/' + opts.dailyCap) + ')')
  log('Report: ' + opts.reportPath)
  log('Mismatches: ' + opts.mismatchesPath + ' (' + mismatchCount + ' rows)')

  if (stopReason === 'daily_cap') {
    log('Daily request cap reached (' + state.count + '/' + opts.dailyCap + ' for ' + state.date + ' UTC). ' +
      unfetched + ' points still unfetched. Re-run the same command after the next UTC day starts to resume; cached points are never re-queried.')
  } else if (stopReason === 'rate_limited') {
    log('LocationIQ returned HTTP 429 (rate limited). Backing off and stopping this run cleanly; all fetched responses are cached. Wait for the quota window to reset, then re-run the same command to resume.')
  } else if (stopReason === 'bad_request') {
    log('LocationIQ rejected the request shape (HTTP 400). This is a configuration problem (endpoint or parameters), so the response was not cached and the run stopped before spending more quota. Fix the configuration, then re-run to resume.')
  } else if (stopReason === 'auth_error') {
    log('LocationIQ rejected the API key (' + stopDetail + '). Check LOCATIONIQ_API_KEY / --api-key, then re-run to resume.')
  } else if (stopReason === 'fetch_error' || stopReason === 'server_error') {
    log('Request failed (' + stopDetail + '). Stopping this run cleanly; re-run the same command to resume from the cache.')
  } else if (stopReason === 'max_requests') {
    log('Per-run request limit reached (--max-requests ' + opts.maxRequests + '). Re-run to continue.')
  } else if (opts.dryRun && unfetched > 0) {
    log('Dry run: ' + unfetched + ' points have no cached response yet; run without --dry-run to fetch them.')
  } else if (unfetched === 0) {
    log('All points have cached LocationIQ responses.')
  }

  return {
    totalPoints: points.length,
    evaluated: records.length,
    unfetched: unfetched,
    requestsThisRun: requestsThisRun,
    quota: { date: state.date, count: state.count },
    stopReason: stopReason,
    stopDetail: stopDetail,
    verdictCounts: verdictCounts,
    mismatchCount: mismatchCount
  }
}

function parseSweepArgs(argv) {
  var opts = {
    pointsPath: null,
    database: null,
    workdir: path.resolve(SWEEP_DEFAULT_WORKDIR),
    cachePath: null,
    statePath: null,
    reportPath: null,
    mismatchesPath: null,
    apiKey: process.env.LOCATIONIQ_API_KEY || '',
    endpoint: 'https://us1.locationiq.com/v1/reverse',
    acceptLanguage: 'en',
    dailyCap: 4500,
    rps: 1,
    maxRequests: null,
    reverseMode: 'boundary',
    basePrecision: 4,
    maxPrecision: 7,
    dryRun: false,
    help: false
  }

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]

    if (arg === '--points') {
      opts.pointsPath = path.resolve(requireValueArg('--points', argv[++i]))
    } else if (arg === '--database' || arg === '-d') {
      opts.database = path.resolve(requireValueArg('--database', argv[++i]))
    } else if (arg === '--workdir') {
      opts.workdir = path.resolve(requireValueArg('--workdir', argv[++i]))
    } else if (arg === '--cache') {
      opts.cachePath = path.resolve(requireValueArg('--cache', argv[++i]))
    } else if (arg === '--state') {
      opts.statePath = path.resolve(requireValueArg('--state', argv[++i]))
    } else if (arg === '--report') {
      opts.reportPath = path.resolve(requireValueArg('--report', argv[++i]))
    } else if (arg === '--mismatches') {
      opts.mismatchesPath = path.resolve(requireValueArg('--mismatches', argv[++i]))
    } else if (arg === '--api-key') {
      opts.apiKey = requireValueArg('--api-key', argv[++i])
    } else if (arg === '--endpoint') {
      opts.endpoint = requireValueArg('--endpoint', argv[++i])
    } else if (arg === '--accept-language') {
      // '' is a documented value (disables the header), but a following
      // option token means the value was omitted.
      opts.acceptLanguage = requireValueArg('--accept-language', argv[++i])
    } else if (arg === '--daily-cap') {
      // Reject non-numeric values outright: a NaN here would silently
      // disable the daily quota instead of enforcing it.
      opts.dailyCap = Math.max(0, Math.trunc(requireNumericArg('--daily-cap', argv[++i])))
    } else if (arg === '--rps') {
      opts.rps = Math.max(0.1, requireNumericArg('--rps', argv[++i]))
    } else if (arg === '--max-requests') {
      opts.maxRequests = Math.max(0, Math.trunc(requireNumericArg('--max-requests', argv[++i])))
    } else if (arg === '--reverse-mode') {
      // The mode defines which lookup algorithm the report measures, so a
      // typo must not silently reconfigure the experiment.
      var reverseMode = String(argv[++i] || '').toLowerCase()
      if (reverseMode !== 'centroid' && reverseMode !== 'boundary') {
        throw new Error('--reverse-mode must be centroid or boundary, got: ' + (argv[i] === undefined ? '(missing)' : argv[i]))
      }
      opts.reverseMode = reverseMode
    } else if (arg === '--base-precision') {
      opts.basePrecision = Math.max(1, Math.trunc(requireNumericArg('--base-precision', argv[++i])))
    } else if (arg === '--max-precision') {
      opts.maxPrecision = Math.max(opts.basePrecision, Math.trunc(requireNumericArg('--max-precision', argv[++i])))
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      throw new Error('Unknown sweep argument: ' + arg)
    }
  }

  if (!opts.cachePath) opts.cachePath = path.join(opts.workdir, 'cache.jsonl')
  if (!opts.statePath) opts.statePath = path.resolve(SWEEP_DEFAULT_STATE_PATH)
  if (!opts.reportPath) opts.reportPath = path.join(opts.workdir, 'report.md')
  if (!opts.mismatchesPath) opts.mismatchesPath = path.join(opts.workdir, 'mismatches.jsonl')

  return opts
}

async function sweepMain(argv) {
  var opts = parseSweepArgs(argv)
  if (opts.help) {
    console.log(sweepUsage())
    return
  }

  if (!opts.pointsPath) {
    throw new Error('Missing required --points (see `sweep --help`; the sample subcommand builds one)')
  }
  if (!fs.existsSync(opts.pointsPath)) {
    throw new Error('Points file not found: ' + opts.pointsPath)
  }
  if (!opts.database) {
    throw new Error('Missing required --database')
  }
  if (!fs.existsSync(opts.database)) {
    throw new Error('Database not found: ' + opts.database)
  }
  if (!opts.dryRun && !opts.apiKey) {
    throw new Error('Missing LocationIQ API key (--api-key or LOCATIONIQ_API_KEY); use --dry-run to evaluate the cache without network')
  }

  fs.mkdirSync(opts.workdir, { recursive: true })

  var geocoder = createGeocoder({
    database: opts.database,
    reverseMode: opts.reverseMode,
    boundary: {
      basePrecision: opts.basePrecision,
      maxPrecision: opts.maxPrecision
    }
  })

  try {
    opts.databaseLabel = opts.database
    await runSweep(opts, {
      fetchJson: fetchJson,
      reverse: function(latitude, longitude) {
        return geocoder.reverse(latitude, longitude)
      },
      sleep: sleep,
      log: console.log
    })
  } finally {
    if (geocoder && geocoder.db && typeof geocoder.db.close === 'function') {
      await new Promise(function(resolve) {
        geocoder.db.close(function() { resolve() })
      })
    }
  }
}

function dispatch() {
  var argv = process.argv.slice(2)
  if (argv[0] === 'sample') return sampleMain(argv.slice(1))
  if (argv[0] === 'sweep') return sweepMain(argv.slice(1))
  if (argv.length && argv[0].charAt(0) !== '-') {
    return Promise.reject(new Error('Unknown subcommand: ' + argv[0] + ' (expected sample, sweep or legacy options; see --help)'))
  }
  return main()
}

module.exports = {
  normalizeName: normalizeName,
  namesMatch: namesMatch,
  extractLocationIqLocality: extractLocationIqLocality,
  buildLocationIqUrl: buildLocationIqUrl,
  parseGeonamesLine: parseGeonamesLine,
  selectTopPlaces: selectTopPlaces,
  buildSamplePoints: buildSamplePoints,
  parseSampleArgs: parseSampleArgs,
  sampleMain: sampleMain,
  sweepCoordKey: sweepCoordKey,
  utcDateString: utcDateString,
  loadPointsFile: loadPointsFile,
  loadQuotaState: loadQuotaState,
  parseSweepArgs: parseSweepArgs,
  comparePoint: comparePoint,
  buildSweepReport: buildSweepReport,
  runSweep: runSweep
}

if (require.main === module) {
  dispatch().catch(function(err) {
    console.error(err.message || err)
    process.exit(1)
  })
}
