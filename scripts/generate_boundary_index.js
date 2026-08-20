#!/usr/bin/env node
"use strict";

const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const geometry = require('../src/geometry')
const boundaryCover = require('../src/boundary_cover')
const geohash = require('../src/geohash')

const PLACETYPE_CODES = {
  locality: 0,
  localadmin: 1,
  region: 2,
  county: 3
}

const PLACETYPE_BY_CODE = {
  0: 'locality',
  1: 'localadmin',
  2: 'region',
  3: 'county'
}

// Precision used to precompute the geohash of a place centroid.  Geohashes are
// hierarchical, so the cell containing a centroid at any precision <= this
// value is a prefix of this string; 12 is deeper than any cover precision the
// builder can emit.
const HOME_CELL_PRECISION = 12

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
    input: [],
    inputDir: [],
    basePrecision: 4,
    maxPrecision: 7,
    includeLocaladmin: false,
    includeCounty: false,
    includeRegion: false,
    replace: true,
    includeAlt: false,
    dropContainedLocalities: true,
    maxPlaces: null,
    geometryDecimals: null,
    minPopulation: 0,
    isolationMinPopulation: null,
    ensureCountryLocality: true,
    indexMode: 'compact',
    localityMaxPrecision: null,
    localadminMaxPrecision: null,
    countyMaxPrecision: null,
    regionMaxPrecision: null,
    regionSparseMaxPrecision: null,
    regionSparseMinAreaKm2: null,
    promoteLocalityOverRegion: true,
    homeCellPriority: true,
    dominantLocalityPopulation: 100000,
    dominantLocalityRatio: 3,
    parentLocalityMinShare: 0.5
  }

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]

    if (arg === '--database' || arg === '-d') {
      opts.database = argv[++i]
    } else if (arg === '--input' || arg === '-i') {
      opts.input.push(argv[++i])
    } else if (arg === '--input-dir') {
      opts.inputDir.push(argv[++i])
    } else if (arg === '--base-precision') {
      opts.basePrecision = Number(argv[++i])
    } else if (arg === '--max-precision') {
      opts.maxPrecision = Number(argv[++i])
    } else if (arg === '--include-localadmin') {
      opts.includeLocaladmin = parseBool(argv[++i], false)
    } else if (arg === '--include-county') {
      opts.includeCounty = parseBool(argv[++i], false)
    } else if (arg === '--include-region') {
      opts.includeRegion = parseBool(argv[++i], false)
    } else if (arg === '--include-alt') {
      opts.includeAlt = parseBool(argv[++i], false)
    } else if (arg === '--drop-contained-localities') {
      opts.dropContainedLocalities = parseBool(argv[++i], true)
    } else if (arg === '--max-places') {
      var maxPlaces = Number(argv[++i])
      opts.maxPlaces = Number.isFinite(maxPlaces) && maxPlaces > 0 ? Math.trunc(maxPlaces) : null
    } else if (arg === '--geometry-decimals') {
      var decimals = Number(argv[++i])
      opts.geometryDecimals = Number.isFinite(decimals) && decimals >= 0 ? Math.trunc(decimals) : null
    } else if (arg === '--min-population') {
      var minPopulation = Number(argv[++i])
      opts.minPopulation = Number.isFinite(minPopulation) && minPopulation > 0 ? Math.trunc(minPopulation) : 0
    } else if (arg === '--isolation-min-population') {
      var isolationMin = Number(argv[++i])
      opts.isolationMinPopulation = Number.isFinite(isolationMin) && isolationMin > 0 ? Math.trunc(isolationMin) : null
    } else if (arg === '--ensure-country-locality') {
      opts.ensureCountryLocality = parseBool(argv[++i], true)
    } else if (arg === '--index-mode') {
      opts.indexMode = String(argv[++i] || '').toLowerCase().trim()
    } else if (arg === '--locality-max-precision') {
      var localityMax = Number(argv[++i])
      opts.localityMaxPrecision = Number.isFinite(localityMax) ? Math.trunc(localityMax) : null
    } else if (arg === '--localadmin-max-precision') {
      var localadminMax = Number(argv[++i])
      opts.localadminMaxPrecision = Number.isFinite(localadminMax) ? Math.trunc(localadminMax) : null
    } else if (arg === '--county-max-precision') {
      var countyMax = Number(argv[++i])
      opts.countyMaxPrecision = Number.isFinite(countyMax) ? Math.trunc(countyMax) : null
    } else if (arg === '--region-max-precision') {
      var regionMax = Number(argv[++i])
      opts.regionMaxPrecision = Number.isFinite(regionMax) ? Math.trunc(regionMax) : null
    } else if (arg === '--region-sparse-max-precision') {
      var regionSparseMax = Number(argv[++i])
      opts.regionSparseMaxPrecision = Number.isFinite(regionSparseMax) ? Math.trunc(regionSparseMax) : null
    } else if (arg === '--region-sparse-min-area-km2') {
      var sparseAreaKm2 = Number(argv[++i])
      opts.regionSparseMinAreaKm2 = Number.isFinite(sparseAreaKm2) && sparseAreaKm2 > 0 ? sparseAreaKm2 : null
    } else if (arg === '--promote-locality-over-region') {
      opts.promoteLocalityOverRegion = parseBool(argv[++i], true)
    } else if (arg === '--home-cell-priority') {
      opts.homeCellPriority = parseBool(argv[++i], true)
    } else if (arg === '--dominant-locality-population') {
      var dominantPopulation = Number(argv[++i])
      opts.dominantLocalityPopulation = Number.isFinite(dominantPopulation) ? dominantPopulation : opts.dominantLocalityPopulation
    } else if (arg === '--dominant-locality-ratio') {
      var dominantRatio = Number(argv[++i])
      opts.dominantLocalityRatio = Number.isFinite(dominantRatio) ? dominantRatio : opts.dominantLocalityRatio
    } else if (arg === '--parent-locality-min-share') {
      var minShare = Number(argv[++i])
      opts.parentLocalityMinShare = Number.isFinite(minShare) ? minShare : opts.parentLocalityMinShare
    } else if (arg === '--append') {
      opts.replace = false
    } else if (arg === '--replace') {
      opts.replace = true
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
    'Usage: node scripts/generate_boundary_index.js --database <db.sqlite> [--input <features.geojson>] [--input-dir <wof-data-dir>]',
    '',
    'Options:',
    '  --database, -d                 SQLite output path (required)',
    '  --input, -i                    GeoJSON FeatureCollection/Feature or NDJSON file (repeatable)',
    '  --input-dir                    Directory to recursively scan for GeoJSON feature files (repeatable)',
    '  --base-precision               Geohash base precision (default: 4)',
    '  --max-precision                Geohash max precision for partial subdivision (default: 7)',
    '  --include-localadmin <bool>    Include localadmin placetypes (default: false)',
    '  --include-county <bool>       Include county placetypes (default: false)',
    '  --include-region <bool>        Include region placetypes (default: false)',
    '  --include-alt <bool>           Include WOF alt geometries (default: false)',
    '  --drop-contained-localities    Drop locality polygons fully contained by larger localities (default: true)',
    '  --max-places                   Stop after this many normalized places (useful for experiments)',
    '  --geometry-decimals            Round geometry coordinates to N decimals before indexing/storage',
    '  --min-population               Drop localities below this threshold (default: 0, country capitals kept)',
    '  --isolation-min-population     Lower population floor for localities in otherwise-empty geohash cells (default: off)',
    '  --ensure-country-locality      Guarantee at least one locality per country (default: true)',
    '  --index-mode                   compact|full (default: compact)',
    '  --locality-max-precision       Max precision override for locality placetype',
    '  --localadmin-max-precision     Max precision override for localadmin placetype',
    '  --county-max-precision         Max precision override for county placetype',
    '  --region-max-precision         Max precision override for region placetype',
    '  --region-sparse-max-precision  Optional precision for very large region polygons (for example 3)',
    '  --region-sparse-min-area-km2   Area threshold to apply sparse region precision',
    '  --promote-locality-over-region Prefer locality over region in shared parent cells when no competing locality exists (default: true)',
    '  --home-cell-priority <bool>    Let a place keep the cell containing its own centroid, ahead of the population tie-break (default: true)',
    '  --dominant-locality-population Population threshold that marks locality as major for dominant-city rollups (default: 100000)',
    '  --dominant-locality-ratio      Required dominant-vs-next population ratio for locality rollups (default: 3)',
    '  --parent-locality-min-share    Minimum child-cell share (0..1) required to let a locality take over a parent cell (default: 0.5)',
    '  --append                       Keep existing boundary rows and append/replace by place id',
    '  --replace                      Clear boundary rows first (default)',
    '  --help, -h                     Show this help message'
  ].join('\n')
}

function collectGeojsonFiles(dirPath, includeAlt, files) {
  var entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var absolutePath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      collectGeojsonFiles(absolutePath, includeAlt, files)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    var lower = entry.name.toLowerCase()
    var isGeojson = lower.endsWith('.geojson') || lower.endsWith('.json') || lower.endsWith('.ndjson')
    if (!isGeojson) {
      continue
    }

    if (!includeAlt && lower.indexOf('-alt-') !== -1) {
      continue
    }

    files.push(absolutePath)
  }
}

function collectInputFiles(opts) {
  var all = []

  for (var i = 0; i < opts.input.length; i++) {
    all.push(path.resolve(opts.input[i]))
  }

  for (var j = 0; j < opts.inputDir.length; j++) {
    var inputDir = path.resolve(opts.inputDir[j])
    if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
      throw new Error('Input directory does not exist: ' + inputDir)
    }

    collectGeojsonFiles(inputDir, opts.includeAlt, all)
  }

  var dedup = Object.create(null)
  all.forEach(function(filePath) {
    dedup[filePath] = true
  })

  return Object.keys(dedup).sort()
}

function readFeatures(filePath) {
  var content = fs.readFileSync(filePath, 'utf8')
  var trimmed = content.trim()

  if (!trimmed) {
    return []
  }

  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    var parsed = JSON.parse(trimmed)

    if (Array.isArray(parsed)) {
      return parsed
    }

    if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      return parsed.features
    }

    if (parsed.type === 'Feature') {
      return [parsed]
    }

    throw new Error('Unsupported JSON root in ' + filePath + '. Expected FeatureCollection, Feature, or array.')
  }

  return trimmed
    .split(/\r?\n/)
    .map(function(line) { return line.trim() })
    .filter(function(line) { return line && line.charAt(0) !== '#' })
    .map(function(line) { return JSON.parse(line) })
}

function pickFirstString(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var candidate = pickFirstString(value[i])
      if (candidate) return candidate
    }
  }

  if (value && typeof value === 'object') {
    var keys = Object.keys(value)
    for (var j = 0; j < keys.length; j++) {
      var nested = pickFirstString(value[keys[j]])
      if (nested) return nested
    }
  }

  return null
}

function parseOptionalInt(value) {
  if (value === null || value === undefined || value === '') return null
  var parsed = Number(value)
  if (Number.isFinite(parsed)) return Math.trunc(parsed)
  return null
}

function parseOptionalFloat(value) {
  if (value === null || value === undefined || value === '') return null
  var parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clampPrecision(value, basePrecision, fallback) {
  if (!Number.isFinite(value) || value < basePrecision) {
    return fallback
  }
  return Math.trunc(value)
}

function parseList(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    var trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : []
      } catch (err) {
        return [trimmed]
      }
    }
    return trimmed.split(',').map(function(item) { return item.trim() }).filter(Boolean)
  }
  return []
}

function isCurrentRecord(properties) {
  var props = properties || {}

  var isCurrent = props.is_current
  if (isCurrent === undefined) {
    isCurrent = props['mz:is_current']
  }
  if (isCurrent !== undefined && isCurrent !== null && Number(isCurrent) <= 0) {
    return false
  }

  var deprecated = props.deprecated
  if (deprecated === undefined) {
    deprecated = props['edtf:deprecated']
  }
  if (deprecated && String(deprecated).toLowerCase() !== 'uuuu') {
    return false
  }

  var supersededBy = props.superseded_by
  if (supersededBy === undefined) {
    supersededBy = props['wof:superseded_by']
  }
  if (parseList(supersededBy).length > 0) {
    return false
  }

  return true
}

function extractName(properties, feature) {
  var props = properties || {}
  return pickFirstString(props.name) ||
    pickFirstString(props['wof:name']) ||
    pickFirstString(props['name:preferred']) ||
    pickFirstString(props.name_preferred) ||
    pickFirstString(feature && feature.id)
}

function extractPlacetype(properties) {
  var props = properties || {}
  return pickFirstString(props.placetype) ||
    pickFirstString(props['wof:placetype']) ||
    pickFirstString(props.place_type)
}

function extractCountryId(properties) {
  var props = properties || {}
  return pickFirstString(props.country_id) ||
    pickFirstString(props['iso:country']) ||
    pickFirstString(props.country_code) ||
    pickFirstString(props.country) ||
    pickFirstString(props['wof:country']) ||
    ''
}

function extractHierarchyRegionId(properties) {
  var hierarchy = properties && properties['wof:hierarchy']
  if (!Array.isArray(hierarchy) || hierarchy.length === 0) {
    return null
  }

  for (var i = 0; i < hierarchy.length; i++) {
    var branch = hierarchy[i]
    if (!branch || typeof branch !== 'object') continue

    var region = parseOptionalInt(branch.region_id)
    if (region !== null) return region
  }

  return null
}

function extractAdmin1Id(properties) {
  var props = properties || {}
  return parseOptionalInt(props.admin1_id) ||
    parseOptionalInt(props['gn:admin1_id']) ||
    parseOptionalInt(props.region_id) ||
    extractHierarchyRegionId(props) ||
    null
}

function extractCentroid(properties, normalizedGeometry) {
  var props = properties || {}

  var lat = parseOptionalFloat(props.centroid_lat)
  if (lat === null) lat = parseOptionalFloat(props['lbl:latitude'])
  if (lat === null) lat = parseOptionalFloat(props['geom:latitude'])

  var lon = parseOptionalFloat(props.centroid_lon)
  if (lon === null) lon = parseOptionalFloat(props['lbl:longitude'])
  if (lon === null) lon = parseOptionalFloat(props['geom:longitude'])

  if (lat !== null && lon !== null) {
    return { latitude: lat, longitude: lon }
  }

  var bbox = geometry.geometryBbox(normalizedGeometry)
  return {
    latitude: (bbox.minLat + bbox.maxLat) / 2,
    longitude: (bbox.minLon + bbox.maxLon) / 2
  }
}

function extractPopulation(properties) {
  var props = properties || {}

  var population = parseOptionalInt(props.population)
  if (population === null) population = parseOptionalInt(props['gn:population'])
  if (population === null) population = parseOptionalInt(props['wof:population'])
  if (population === null) population = parseOptionalInt(props['mz:population'])

  if (population === null || population < 0) {
    return 0
  }

  return population
}

function bboxAreaKm2(bbox) {
  var centerLat = (Number(bbox.minLat) + Number(bbox.maxLat)) / 2
  var deltaLat = Math.abs(Number(bbox.maxLat) - Number(bbox.minLat))
  var deltaLon = Math.abs(Number(bbox.maxLon) - Number(bbox.minLon))
  var latKm = deltaLat * 111.32
  var lonKm = deltaLon * 111.32 * Math.cos(centerLat * Math.PI / 180)
  return Math.max(0, latKm * Math.max(0, lonKm))
}

function roundCoordinate(value, decimals) {
  var factor = Math.pow(10, decimals)
  return Math.round(Number(value) * factor) / factor
}

function roundRing(ring, decimals) {
  var points = []
  for (var i = 0; i < ring.length; i++) {
    var lon = roundCoordinate(ring[i][0], decimals)
    var lat = roundCoordinate(ring[i][1], decimals)

    if (!points.length) {
      points.push([lon, lat])
      continue
    }

    var prev = points[points.length - 1]
    if (prev[0] !== lon || prev[1] !== lat) {
      points.push([lon, lat])
    }
  }

  if (!points.length) return points

  var first = points[0]
  var last = points[points.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    points.push([first[0], first[1]])
  }

  return points
}

function quantizeGeometry(inputGeometry, decimals) {
  if (!Number.isFinite(decimals)) {
    return geometry.normalizeGeometry(inputGeometry)
  }

  var normalized = geometry.normalizeGeometry(inputGeometry)
  var rounded = normalized.coordinates.map(function(polygon) {
    return polygon
      .map(function(ring) { return roundRing(ring, decimals) })
      .filter(function(ring) { return ring.length >= 4 })
  }).filter(function(polygon) {
    return polygon.length > 0
  })

  if (!rounded.length) {
    return normalized
  }

  return geometry.normalizeGeometry({
    type: 'MultiPolygon',
    coordinates: rounded
  })
}

function isCapitalLocality(properties) {
  var props = properties || {}

  var featureCode = pickFirstString(props['gn:feature_code']) ||
    pickFirstString(props['gn:fcode']) ||
    pickFirstString(props['ne:FEATURE_CO']) ||
    ''

  if (String(featureCode).toUpperCase() === 'PPLC') {
    return true
  }

  var capitalOf = props['wof:capital_of']
  return Array.isArray(capitalOf) && capitalOf.length > 0
}

function extractPointCoordinates(pointGeometry) {
  if (!pointGeometry || pointGeometry.type !== 'Point' || !Array.isArray(pointGeometry.coordinates)) {
    return null
  }

  var lon = parseOptionalFloat(pointGeometry.coordinates[0])
  var lat = parseOptionalFloat(pointGeometry.coordinates[1])
  if (lat === null || lon === null) {
    return null
  }

  return {
    latitude: lat,
    longitude: lon
  }
}

function bboxPolygon(bbox) {
  return {
    type: 'Polygon',
    coordinates: [[
      [bbox.minLon, bbox.minLat],
      [bbox.maxLon, bbox.minLat],
      [bbox.maxLon, bbox.maxLat],
      [bbox.minLon, bbox.maxLat],
      [bbox.minLon, bbox.minLat]
    ]]
  }
}

function normalizeFeature(feature, opts) {
  if (!feature || feature.type !== 'Feature') {
    return null
  }

  if (!feature.geometry || !feature.geometry.type) {
    return null
  }

  var properties = feature.properties || {}
  var placetype = (extractPlacetype(properties) || '').toLowerCase()
  if (!isCurrentRecord(properties)) {
    return null
  }

  var include = placetype === 'locality' ||
    (opts.includeLocaladmin && placetype === 'localadmin') ||
    (opts.includeCounty && placetype === 'county') ||
    (opts.includeRegion && placetype === 'region')
  if (!include) {
    return null
  }

  var population = extractPopulation(properties)
  var isCapital = placetype === 'locality' && isCapitalLocality(properties)
  var isCityLikePlacetype = placetype === 'locality' || placetype === 'county'
  var isolationCandidate = false
  if (isCityLikePlacetype && population < opts.minPopulation && !isCapital) {
    var isolationFloor = opts.isolationMinPopulation
    if (Number.isFinite(isolationFloor) && isolationFloor > 0 && population >= isolationFloor) {
      isolationCandidate = true
    } else {
      return null
    }
  }

  var rawId = feature.id
  if (rawId === undefined || rawId === null || rawId === '') rawId = properties.id
  if (rawId === undefined || rawId === null || rawId === '') rawId = properties['wof:id']
  var id = parseOptionalInt(rawId)
  if (id === null) {
    return null
  }

  var geometryType = feature.geometry.type
  var isPolygonGeometry = geometryType === 'Polygon' || geometryType === 'MultiPolygon'
  var isPointCapital = geometryType === 'Point' && isCapital
  if (!isPolygonGeometry && !isPointCapital) {
    return null
  }

  var normalizedGeometry
  var pointCapitalHash = null

  if (isPointCapital) {
    var point = extractPointCoordinates(feature.geometry)
    if (!point) {
      return null
    }

    pointCapitalHash = geohash.encode(point.latitude, point.longitude, opts.localityMaxPrecision)
    normalizedGeometry = geometry.normalizeGeometry(bboxPolygon(geohash.decodeBbox(pointCapitalHash)))
  } else {
    normalizedGeometry = quantizeGeometry(feature.geometry, opts.geometryDecimals)
  }

  var bbox = geometry.geometryBbox(normalizedGeometry)
  var centroid = extractCentroid(properties, normalizedGeometry)
  var countryId = extractCountryId(properties)

  var name = extractName(properties, feature)
  if (!name) {
    return null
  }

  var priorityRank = parseOptionalInt(properties.priority_rank)
  if (priorityRank === null) priorityRank = 0
  var maxPrecisionForPlace = resolveMaxPrecisionForPlacetype(opts, placetype, bbox)
  var cover = pointCapitalHash
    ? [{
      geohash: pointCapitalHash,
      precision: pointCapitalHash.length,
      coverageType: 'full'
    }]
    : boundaryCover.buildGeohashCoverForGeometry(normalizedGeometry, {
      basePrecision: Math.min(opts.basePrecision, maxPrecisionForPlace),
      maxPrecision: maxPrecisionForPlace
    })

  var area = geometry.geometryArea(normalizedGeometry)

  // In compact mode, geometry is not written to the DB.  Retain it only
  // for full index mode which stores polygons.
  var retainGeometry = opts.indexMode !== 'compact'

  return {
    id: id,
    name: name,
    countryId: countryId,
    admin1Id: extractAdmin1Id(properties),
    placetype: placetype,
    placetypeCode: placetypeCode(placetype),
    centroidLat: centroid.latitude,
    centroidLon: centroid.longitude,
    homeGeohash: geohash.encode(centroid.latitude, centroid.longitude, HOME_CELL_PRECISION),
    population: population,
    bboxMinLat: bbox.minLat,
    bboxMinLon: bbox.minLon,
    bboxMaxLat: bbox.maxLat,
    bboxMaxLon: bbox.maxLon,
    priorityRank: priorityRank,
    area: area,
    countryName: pickFirstString(properties.country_name) || countryId || null,
    admin1Name: pickFirstString(properties.admin1_name) || null,
    geometry: retainGeometry ? normalizedGeometry : null,
    cover: cover,
    isolationCandidate: isolationCandidate
  }
}

function localityGroupKey(place) {
  return String(place.countryId || '') + '|' + String(place.admin1Id === null ? '' : place.admin1Id)
}

function pruneContainedLocalities(places, enabled) {
  if (!enabled) {
    return {
      places: places,
      dropped: []
    }
  }

  var localitiesByGroup = Object.create(null)
  for (var i = 0; i < places.length; i++) {
    var place = places[i]
    if (!isCityPlacetypeCode(place.placetypeCode)) continue

    // Group by placetype + country/admin1 so localities are only pruned by
    // other localities, not by counties that happen to contain them.
    var key = place.placetypeCode + '|' + localityGroupKey(place)
    if (!localitiesByGroup[key]) {
      localitiesByGroup[key] = []
    }

    localitiesByGroup[key].push(place)
  }

  var dropById = Object.create(null)

  var groupKeys = Object.keys(localitiesByGroup)
  for (var g = 0; g < groupKeys.length; g++) {
    var key = groupKeys[g]
    var group = localitiesByGroup[key]

    group.sort(function(a, b) {
      if (a.area !== b.area) return a.area - b.area
      return a.id - b.id
    })

    for (var i = 0; i < group.length; i++) {
      var candidate = group[i]
      if (dropById[candidate.id]) continue

      for (var j = i + 1; j < group.length; j++) {
        var container = group[j]
        if (dropById[container.id]) continue
        if (container.area <= candidate.area) continue

        var containsBbox = geometry.bboxContainsBbox({
          minLat: container.bboxMinLat,
          minLon: container.bboxMinLon,
          maxLat: container.bboxMaxLat,
          maxLon: container.bboxMaxLon
        }, {
          minLat: candidate.bboxMinLat,
          minLon: candidate.bboxMinLon,
          maxLat: candidate.bboxMaxLat,
          maxLon: candidate.bboxMaxLon
        })

        if (!containsBbox) {
          continue
        }

        // Use full geometry containment when available, otherwise bbox is sufficient
        var geometryContains = container.geometry && candidate.geometry
          ? geometry.geometryContainsGeometry(container.geometry, candidate.geometry)
          : true
        if (geometryContains) {
          dropById[candidate.id] = {
            placeId: candidate.id,
            containedBy: container.id,
            group: key
          }
          break
        }
      }
    }
  }

  var dropped = Object.keys(dropById).map(function(id) { return dropById[id] })
  var filtered = places.filter(function(place) {
    return !dropById[place.id]
  })

  return {
    places: filtered,
    dropped: dropped
  }
}

function pruneRedundantRegions(places) {
  var localitiesByKey = Object.create(null)
  for (var i = 0; i < places.length; i++) {
    var place = places[i]
    if (place.placetypeCode !== PLACETYPE_CODES.locality) continue
    var key = place.name + '|' + place.countryId
    if (!localitiesByKey[key]) {
      localitiesByKey[key] = []
    }
    localitiesByKey[key].push(place)
  }

  // Only treat a region as redundant when a same-named locality covers most
  // of the region's bbox area. A bare bbox-contains check would drop legit
  // regions that simply happen to contain a same-named city (e.g. New York
  // state contains New York city).
  var REDUNDANT_AREA_SHARE = 0.5

  var dropById = Object.create(null)
  for (var i = 0; i < places.length; i++) {
    var region = places[i]
    if (region.placetypeCode !== PLACETYPE_CODES.region) continue

    var key = region.name + '|' + region.countryId
    var matchingLocalities = localitiesByKey[key]
    if (!matchingLocalities) continue

    var regionBbox = {
      minLat: region.bboxMinLat,
      minLon: region.bboxMinLon,
      maxLat: region.bboxMaxLat,
      maxLon: region.bboxMaxLon
    }
    var regionAreaKm2 = bboxAreaKm2(regionBbox)
    if (!(regionAreaKm2 > 0)) continue

    for (var j = 0; j < matchingLocalities.length; j++) {
      var locality = matchingLocalities[j]
      var localityBbox = {
        minLat: locality.bboxMinLat,
        minLon: locality.bboxMinLon,
        maxLat: locality.bboxMaxLat,
        maxLon: locality.bboxMaxLon
      }

      if (!geometry.bboxContainsBbox(regionBbox, localityBbox)) continue

      var localityAreaKm2 = bboxAreaKm2(localityBbox)
      if (localityAreaKm2 / regionAreaKm2 < REDUNDANT_AREA_SHARE) continue

      dropById[region.id] = {
        placeId: region.id,
        replacedBy: locality.id
      }
      break
    }
  }

  var dropped = Object.keys(dropById).map(function(id) { return dropById[id] })
  var filtered = places.filter(function(place) {
    return !dropById[place.id]
  })

  return {
    places: filtered,
    dropped: dropped
  }
}

function placetypeRank(placetype) {
  if (placetype === 'locality') return 0
  if (placetype === 'localadmin') return 1
  if (placetype === 'county') return 1
  if (placetype === 'region') return 2
  return 3
}

function placetypeCode(placetype) {
  var code = PLACETYPE_CODES[placetype]
  return Number.isFinite(code) ? code : 9
}

function resolveMaxPrecisionForPlacetype(opts, placetype, bbox) {
  if (placetype === 'locality') return opts.localityMaxPrecision
  if (placetype === 'localadmin') return opts.localadminMaxPrecision
  if (placetype === 'county') return opts.countyMaxPrecision
  if (placetype === 'region') {
    var regionPrecision = opts.regionMaxPrecision
    if (Number.isFinite(opts.regionSparseMaxPrecision) && Number.isFinite(opts.regionSparseMinAreaKm2)) {
      var areaKm2 = bboxAreaKm2(bbox)
      if (areaKm2 >= opts.regionSparseMinAreaKm2) {
        regionPrecision = Math.min(regionPrecision, opts.regionSparseMaxPrecision)
      }
    }
    return regionPrecision
  }
  return opts.maxPrecision
}

function pointDistanceScore(latitude, longitude, targetLatitude, targetLongitude) {
  var lat = Number(latitude)
  var lon = Number(longitude)
  var targetLat = Number(targetLatitude)
  var targetLon = Number(targetLongitude)
  var scale = Math.pow(Math.cos(lat * Math.PI / 180), 2)

  return ((lat - targetLat) * (lat - targetLat)) +
    ((lon - targetLon) * (lon - targetLon) * scale)
}

// A place owns the "home cell" of a geohash when its own centroid falls inside
// that cell.  Cover cells are the terminal nodes of a quadtree walk and never
// nest, so a place has at most one home cell in its own cover and this prefix
// test is exact for every cell the comparator can be asked about.
function ownsHomeCell(place, hash) {
  if (!place || !hash) {
    return false
  }

  var home = place.homeGeohash
  if (typeof home !== 'string') {
    return false
  }

  // Builds deeper than the precomputed precision encode the centroid at the
  // cell's own length instead of silently dropping the claim.
  if (home.length < hash.length) {
    return geohash.encode(place.centroidLat, place.centroidLon, hash.length) === hash
  }

  return home.slice(0, hash.length) === hash
}

// Two places are foreign to each other only when both country ids are known
// and differ; an unknown country is treated as "same country" so the rollup
// keeps its current behaviour on records without one.
function isForeignTo(place, other) {
  if (!place || !other) {
    return false
  }

  var placeCountry = place.countryId
  var otherCountry = other.countryId
  if (!placeCountry || !otherCountry) {
    return false
  }

  return String(placeCountry).toUpperCase() !== String(otherCountry).toUpperCase()
}

function comparePlacesForHash(a, b, hash, hashCenterCache, homeCellPriority) {
  var typeRankA = placetypeRank(a.placetype)
  var typeRankB = placetypeRank(b.placetype)
  if (typeRankA !== typeRankB) {
    return typeRankA - typeRankB
  }

  // Within a placetype, a place that sits in the cell keeps it even when a
  // bigger neighbour also covers it.  Without this, a border town loses the
  // cell holding its own centroid to the larger city on the other side and
  // resolves to the wrong country.  When both centroids share the cell the
  // usual population ordering decides.
  if (homeCellPriority) {
    var homeA = ownsHomeCell(a, hash)
    var homeB = ownsHomeCell(b, hash)
    if (homeA !== homeB) {
      return homeA ? -1 : 1
    }
  }

  if (a.population !== b.population) {
    return b.population - a.population
  }

  var center = hashCenterCache[hash]
  if (!center) {
    var bbox = geohash.decodeBbox(hash)
    center = {
      latitude: (bbox.minLat + bbox.maxLat) / 2,
      longitude: (bbox.minLon + bbox.maxLon) / 2
    }
    hashCenterCache[hash] = center
  }

  var distanceA = pointDistanceScore(center.latitude, center.longitude, a.centroidLat, a.centroidLon)
  var distanceB = pointDistanceScore(center.latitude, center.longitude, b.centroidLat, b.centroidLon)
  if (distanceA !== distanceB) {
    return distanceA - distanceB
  }

  if (a.area !== b.area) {
    return a.area - b.area
  }

  return a.id - b.id
}

function isCityPlacetypeCode(code) {
  return code === PLACETYPE_CODES.locality || code === PLACETYPE_CODES.localadmin || code === PLACETYPE_CODES.county
}

// Rebuild a comparable place record from a stored compact_places row so that
// appended batches can be ranked against places written by earlier batches.
// Databases created before population/area were stored yield NULL for those
// columns; they are treated as population 0 / area 0.
function cellCandidateFromCompactRow(row) {
  var population = Number(row.population)
  if (!Number.isFinite(population) || population < 0) population = 0

  var area = Number(row.area)
  if (!Number.isFinite(area) || area < 0) area = 0

  var latitude = Number(row.latitude)
  var longitude = Number(row.longitude)
  var homeGeohash = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? geohash.encode(latitude, longitude, HOME_CELL_PRECISION)
    : null

  return {
    id: Number(row.id),
    placetype: PLACETYPE_BY_CODE[Number(row.placetype_code)] || 'region',
    population: population,
    centroidLat: latitude,
    centroidLon: longitude,
    homeGeohash: homeGeohash,
    area: area
  }
}

function placePopulation(place) {
  if (!place) return 0

  var pop = Number(place.population)
  if (!Number.isFinite(pop) || pop < 0) {
    return 0
  }

  return pop
}

function isMajorLocality(place, opts) {
  if (!place || !isCityPlacetypeCode(place.placetypeCode)) {
    return false
  }

  var threshold = Number(opts.dominantLocalityPopulation)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return false
  }

  return placePopulation(place) >= threshold
}

function selectDominantLocalityId(localityIds, placeById, opts) {
  if (!Array.isArray(localityIds) || localityIds.length < 2) {
    return null
  }

  var threshold = Number(opts.dominantLocalityPopulation)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return null
  }

  var ratio = Number(opts.dominantLocalityRatio)
  if (!Number.isFinite(ratio) || ratio < 1) {
    ratio = 1
  }

  var ranked = localityIds
    .map(function(id) {
      var place = placeById[String(id)]
      return {
        id: Number(id),
        population: placePopulation(place)
      }
    })
    .sort(function(a, b) {
      if (a.population !== b.population) {
        return b.population - a.population
      }
      return a.id - b.id
    })

  if (!ranked.length) {
    return null
  }

  var top = ranked[0]
  if (top.population < threshold) {
    return null
  }

  for (var i = 1; i < ranked.length; i++) {
    if (ranked[i].population >= threshold) {
      return null
    }
  }

  var secondPopulation = ranked.length > 1 ? ranked[1].population : 0
  if (secondPopulation > 0 && top.population < secondPopulation * ratio) {
    return null
  }

  return top.id
}

function localityShareInParent(localityId, group) {
  if (!group) return 0

  var counts = group.localityCellCountById || Object.create(null)
  var localityCount = Number(counts[String(localityId)] || 0)
  if (!localityCount) {
    return 0
  }

  return localityCount / 32
}

function localityShareMeetsThreshold(localityId, group, opts) {
  var threshold = Number(opts.parentLocalityMinShare)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return true
  }

  return localityShareInParent(localityId, group) >= threshold
}

// Minor localities are folded into the dominant city, which is what makes a
// metro read as one name.  The exception is a town in another country:
// absorbing the cell holding its centroid would put its own centre on the
// wrong side of a border, which no label choice can justify.  Intra-country
// absorption is deliberate and stays untouched.
function protectsForeignHomeCell(place, hash, dominantPlace, opts) {
  if (!opts.homeCellPriority || !place) {
    return false
  }

  return isCityPlacetypeCode(place.placetypeCode) &&
    ownsHomeCell(place, hash) &&
    isForeignTo(place, dominantPlace)
}

// The cell map is keyed by exact hash, so the comparator only ever ranks
// places that emitted the *same* cell.  Cover cells never nest within one
// place, but they do nest across places: a town can win the coarse cell that
// holds its centroid while a neighbour emits a finer cell over the same point,
// and the runtime's longest-prefix walk then answers with the neighbour.
// Replay the ownership rule down the chain of cells containing the centroid so
// the home-cell guarantee holds at lookup time, not merely per hash.  Only
// existing cells are reassigned - no new cell is created, so this cannot grow
// the index.
function reconcileNestedHomeCells(bestByHash, placeById, opts) {
  if (!opts.homeCellPriority) {
    return 0
  }

  // Collect every claim before applying any of it.  A claimant can lose its
  // own cell to a coarser claimant partway through the pass, and reading the
  // owner map as it mutates would then drop the displaced place's claim on the
  // cells below - which made the result depend on the order places were read.
  // Each cell is still settled by a running maximum under the comparator, so
  // applying the claims in any order gives the same map.
  var hashes = Object.keys(bestByHash)
  var deepest = 0
  var claims = []

  for (var i = 0; i < hashes.length; i++) {
    var hash = hashes[i]
    if (hash.length > deepest) {
      deepest = hash.length
    }

    var place = placeById[String(bestByHash[hash])]
    if (!place || !ownsHomeCell(place, hash)) {
      continue
    }

    claims.push({ place: place, precision: hash.length })
  }

  var hashCenterCache = Object.create(null)
  var reassigned = 0

  for (var claimIndex = 0; claimIndex < claims.length; claimIndex++) {
    var claimant = claims[claimIndex].place

    for (var length = claims[claimIndex].precision + 1; length <= deepest; length++) {
      var finerHash = geohash.encode(claimant.centroidLat, claimant.centroidLon, length)
      var incumbentId = bestByHash[finerHash]
      if (incumbentId === undefined || Number(incumbentId) === Number(claimant.id)) {
        continue
      }

      var incumbent = placeById[String(incumbentId)]
      if (!incumbent) {
        continue
      }

      // Reassign only when the same comparator that governs a single cell
      // would hand this one over, so placetype rank still outranks the home
      // cell and a cell shared by two centroids keeps its population ordering.
      if (comparePlacesForHash(claimant, incumbent, finerHash, hashCenterCache, true) < 0) {
        bestByHash[finerHash] = claimant.id
        reassigned += 1
      }
    }
  }

  return reassigned
}

function promoteLocalityParentsByRegionCompetition(bestByHash, placeById, opts) {
  if (!opts.promoteLocalityOverRegion) {
    return 0
  }

  var refusedPromotions = 0
  var minPrecision = Number(opts.basePrecision || 1)
  var maxPrecision = Number(opts.maxPrecision || minPrecision)
  if (maxPrecision <= minPrecision) {
    return refusedPromotions
  }

  for (var precision = maxPrecision - 1; precision >= minPrecision; precision--) {
    var childPrecision = precision + 1
    var groupByParent = Object.create(null)
    var hashes = Object.keys(bestByHash)

    for (var i = 0; i < hashes.length; i++) {
      var hash = hashes[i]
      if (hash.length !== childPrecision) continue

      var place = placeById[String(bestByHash[hash])]
      if (!place) continue

      var parent = hash.slice(0, precision)
      var group = groupByParent[parent]
      if (!group) {
        group = {
          localityById: Object.create(null),
          localityCellCountById: Object.create(null),
          hasRegion: false
        }
        groupByParent[parent] = group
      }

      if (isCityPlacetypeCode(place.placetypeCode)) {
        group.localityById[String(place.id)] = true
        group.localityCellCountById[String(place.id)] = Number(group.localityCellCountById[String(place.id)] || 0) + 1
      } else if (place.placetypeCode === PLACETYPE_CODES.region) {
        group.hasRegion = true
      }
    }

    var promotedParents = Object.create(null)
    var parentHashes = Object.keys(groupByParent)
    for (var parentIndex = 0; parentIndex < parentHashes.length; parentIndex++) {
      var parentHash = parentHashes[parentIndex]
      var group = groupByParent[parentHash]
      var localityIds = Object.keys(group.localityById)
      if (!localityIds.length) {
        continue
      }

      var promotion = null
      var existingId = bestByHash[parentHash]
      var existingPlace = existingId !== undefined ? placeById[String(existingId)] : null

      if (localityIds.length === 1) {
        var localityId = Number(localityIds[0])
        if (!localityShareMeetsThreshold(localityId, group, opts)) {
          continue
        }

        var hasRegionCompetition = group.hasRegion
        if (existingPlace && isCityPlacetypeCode(existingPlace.placetypeCode) && Number(existingId) !== localityId) {
          continue
        }
        if (existingPlace && existingPlace.placetypeCode === PLACETYPE_CODES.region) {
          hasRegionCompetition = true
        }

        if (!hasRegionCompetition) {
          continue
        }

        promotion = {
          localityId: localityId,
          suppressMinorLocalities: false
        }
      } else {
        var dominantLocalityId = selectDominantLocalityId(localityIds, placeById, opts)
        if (dominantLocalityId === null) {
          continue
        }
        if (!localityShareMeetsThreshold(dominantLocalityId, group, opts)) {
          continue
        }

        if (existingPlace &&
          isCityPlacetypeCode(existingPlace.placetypeCode) &&
          Number(existingId) !== dominantLocalityId &&
          isMajorLocality(existingPlace, opts)) {
          continue
        }

        promotion = {
          localityId: dominantLocalityId,
          suppressMinorLocalities: true
        }
      }

      // The parent cell can itself be the home cell of a town across the
      // border.  The descendant sweep below only visits hashes longer than
      // `precision`, so without this check the promotion would overwrite that
      // town's own centroid cell and never get the chance to protect it.
      if (protectsForeignHomeCell(existingPlace, parentHash, placeById[String(promotion.localityId)], opts)) {
        refusedPromotions += 1
        continue
      }

      bestByHash[parentHash] = promotion.localityId
      promotedParents[parentHash] = promotion
    }

    if (!Object.keys(promotedParents).length) {
      continue
    }

    var descendantHashes = Object.keys(bestByHash)
    for (var hashIndex = 0; hashIndex < descendantHashes.length; hashIndex++) {
      var descendantHash = descendantHashes[hashIndex]
      if (descendantHash.length <= precision) continue

      var ancestor = descendantHash.slice(0, precision)
      var promoted = promotedParents[ancestor]
      if (!promoted || descendantHash === ancestor) {
        continue
      }

      var descendantPlaceId = Number(bestByHash[descendantHash])
      if (descendantPlaceId === promoted.localityId) {
        continue
      }

      var descendantPlace = placeById[String(descendantPlaceId)]
      if (!descendantPlace) {
        continue
      }

      if (descendantPlace.placetypeCode === PLACETYPE_CODES.region) {
        delete bestByHash[descendantHash]
        continue
      }

      var dominantPlace = placeById[String(promoted.localityId)]
      var protectedHomeCell = protectsForeignHomeCell(
        descendantPlace,
        descendantHash,
        dominantPlace,
        opts
      )

      // The rollup makes a metro read as one city, so it may only fold a place
      // into a better- or equally-ranked label.  A county absorbing a locality
      // is a downgrade the comparator would never make, and it also strips the
      // town of the cell holding its own centre - which in an append build is
      // then taken by whichever neighbouring country was written first,
      // because nothing is left to defend it.
      var dominantOutranks = dominantPlace &&
        placetypeRank(dominantPlace.placetype) <= placetypeRank(descendantPlace.placetype)

      if (promoted.suppressMinorLocalities &&
        isCityPlacetypeCode(descendantPlace.placetypeCode) &&
        !isMajorLocality(descendantPlace, opts) &&
        dominantOutranks &&
        !protectedHomeCell) {
        delete bestByHash[descendantHash]
      }
    }
  }

  return refusedPromotions
}

function buildCompactLookupRows(places, opts) {
  var bestByHash = Object.create(null)
  var hashCenterCache = Object.create(null)
  var placeById = Object.create(null)

  for (var index = 0; index < places.length; index++) {
    placeById[String(places[index].id)] = places[index]
  }

  for (var i = 0; i < places.length; i++) {
    var place = places[i]
    for (var j = 0; j < place.cover.length; j++) {
      var cell = place.cover[j]
      var hash = cell.geohash
      var current = bestByHash[hash]
      if (!current || comparePlacesForHash(place, current, hash, hashCenterCache, opts.homeCellPriority) < 0) {
        bestByHash[hash] = place
      }
    }
  }

  var bestByHashId = Object.create(null)
  var allHashes = Object.keys(bestByHash)
  for (var hashIndex = 0; hashIndex < allHashes.length; hashIndex++) {
    var currentHash = allHashes[hashIndex]
    bestByHashId[currentHash] = bestByHash[currentHash].id
  }

  // Runs before the rollup so the metro rollup keeps the last word on which
  // cells a dominant city absorbs inside its own country.
  var nestedHomeCellFixes = reconcileNestedHomeCells(bestByHashId, placeById, opts)

  var refusedPromotions = promoteLocalityParentsByRegionCompetition(bestByHashId, placeById, opts)

  var rows = Object.keys(bestByHashId).map(function(hash) {
    return {
      geohash: hash,
      placeId: bestByHashId[hash]
    }
  })

  rows.sort(function(a, b) {
    if (a.geohash.length !== b.geohash.length) {
      return a.geohash.length - b.geohash.length
    }
    if (a.geohash < b.geohash) return -1
    if (a.geohash > b.geohash) return 1
    return 0
  })

  var compact = []
  var selectedByHash = Object.create(null)
  var shadowedRowsKept = 0

  for (var index = 0; index < rows.length; index++) {
    var row = rows[index]

    // Only the *nearest* kept ancestor decides whether a row can be dropped.
    // The runtime answers with the longest matching prefix, so a row is
    // redundant only when the cell that would answer in its place already
    // names the same place.  Matching any ancestor drops rows that a nearer,
    // different owner shadows, and the lookup then returns that other place.
    var nearestAncestor
    for (var precision = row.geohash.length - 1; precision >= 1; precision--) {
      var ancestor = selectedByHash[row.geohash.slice(0, precision)]
      if (ancestor !== undefined) {
        nearestAncestor = ancestor
        break
      }
    }

    if (nearestAncestor === row.placeId) {
      continue
    }

    for (var farther = row.geohash.length - 1; farther >= 1; farther--) {
      if (selectedByHash[row.geohash.slice(0, farther)] === row.placeId) {
        shadowedRowsKept += 1
        break
      }
    }

    selectedByHash[row.geohash] = row.placeId
    compact.push(row)
  }

  return {
    rows: compact,
    placeById: placeById,
    nestedHomeCellFixes: nestedHomeCellFixes,
    refusedPromotions: refusedPromotions,
    shadowedRowsKept: shadowedRowsKept
  }
}

// In append mode a lookup cell may already belong to a place written by an
// earlier batch (for example another country sharing a border cell). A plain
// INSERT OR REPLACE would hand the cell to whichever batch ran last, so rank
// the existing owner against the appended candidate with the same comparator
// used within a batch and keep the better match. Cells owned by places that
// are part of the current batch are always rewritten, because their rows are
// deleted and replaced by this run.
async function resolveExistingCellConflicts(db, rows, placeById, batchPlaceIds, homeCellPriority) {
  if (!rows.length) {
    return { rows: rows, skipped: 0 }
  }

  var tables = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='compact_geohash_lookup'")
  if (!tables.length) {
    return { rows: rows, skipped: 0 }
  }

  var existingByHash = Object.create(null)
  var chunkSize = 400

  for (var offset = 0; offset < rows.length; offset += chunkSize) {
    var chunk = rows.slice(offset, offset + chunkSize)
    var placeholders = chunk.map(function() { return '?' }).join(',')
    var params = chunk.map(function(row) { return row.geohash })

    var existingRows = await dbAll(db, `
      SELECT
        l.geohash AS geohash,
        p.id AS id,
        p.placetype_code AS placetype_code,
        p.population AS population,
        p.area AS area,
        p.latitude AS latitude,
        p.longitude AS longitude
      FROM compact_geohash_lookup l
      JOIN compact_places p ON p.id = l.place_id
      WHERE l.geohash IN (${placeholders})
    `, params)

    existingRows.forEach(function(row) {
      existingByHash[row.geohash] = row
    })
  }

  var hashCenterCache = Object.create(null)
  var kept = []
  var skipped = 0

  rows.forEach(function(row) {
    var existing = existingByHash[row.geohash]
    if (!existing || batchPlaceIds[String(existing.id)]) {
      kept.push(row)
      return
    }

    var incumbent = cellCandidateFromCompactRow(existing)
    var challenger = placeById[String(row.placeId)]

    if (!challenger || comparePlacesForHash(incumbent, challenger, row.geohash, hashCenterCache, homeCellPriority) <= 0) {
      skipped += 1
      return
    }

    kept.push(row)
  })

  return { rows: kept, skipped: skipped }
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

function stmtRun(stmt, params) {
  return new Promise(function(resolve, reject) {
    stmt.run(params, function(err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

function stmtFinalize(stmt) {
  return new Promise(function(resolve, reject) {
    stmt.finalize(function(err) {
      if (err) reject(err)
      else resolve()
    })
  })
}

// Databases produced before population/area were stored in compact_places
// (they ship without those columns) are upgraded in place when appending.
// The columns are nullable so existing rows stay valid and older readers,
// which select columns by name, are unaffected.
async function ensureCompactPlacesColumns(db) {
  var columns = await dbAll(db, 'PRAGMA table_info(compact_places)')
  var names = Object.create(null)
  columns.forEach(function(column) {
    names[column.name] = true
  })

  if (!names.population) {
    await dbExec(db, 'ALTER TABLE compact_places ADD COLUMN population REAL')
  }
  if (!names.area) {
    await dbExec(db, 'ALTER TABLE compact_places ADD COLUMN area REAL')
  }
}

async function ensureBoundarySchema(db, opts) {
  if (opts.indexMode === 'compact') {
    if (opts.replace) {
      await dbExec(db, `
        DROP TABLE IF EXISTS compact_geohash_lookup;
        DROP TABLE IF EXISTS compact_places;
        DROP TABLE IF EXISTS place_geohash_cover;
        DROP TABLE IF EXISTS place_geometry;
        DROP TABLE IF EXISTS place_geohash_lookup;
        DROP TABLE IF EXISTS places;
        DROP TABLE IF EXISTS countries;
        DROP TABLE IF EXISTS admin1;
      `)
    }

    await dbExec(db, `
      CREATE TABLE IF NOT EXISTS compact_places(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        country_id TEXT NOT NULL,
        admin1_id INTEGER,
        placetype_code INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        population REAL,
        area REAL
      );

      CREATE TABLE IF NOT EXISTS compact_geohash_lookup(
        geohash TEXT PRIMARY KEY,
        place_id INTEGER NOT NULL,
        FOREIGN KEY (place_id) REFERENCES compact_places(id)
      );

      CREATE INDEX IF NOT EXISTS compact_places_placetype_code ON compact_places (placetype_code);
      CREATE INDEX IF NOT EXISTS compact_geohash_lookup_place_id ON compact_geohash_lookup (place_id);
    `)
    await ensureCompactPlacesColumns(db)
    return
  }

  await dbExec(db, `
    CREATE TABLE IF NOT EXISTS countries(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin1(
      country_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (country_id, id)
    );

    CREATE TABLE IF NOT EXISTS places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      country_id TEXT NOT NULL,
      admin1_id INTEGER,
      placetype TEXT NOT NULL,
      centroid_lat REAL NOT NULL,
      centroid_lon REAL NOT NULL,
      bbox_min_lat REAL NOT NULL,
      bbox_min_lon REAL NOT NULL,
      bbox_max_lat REAL NOT NULL,
      bbox_max_lon REAL NOT NULL,
      priority_rank INTEGER NOT NULL DEFAULT 0,
      area REAL NOT NULL DEFAULT 0,
      country_name TEXT,
      admin1_name TEXT
    );

    CREATE TABLE IF NOT EXISTS place_geohash_cover(
      geohash TEXT NOT NULL,
      precision INTEGER NOT NULL,
      place_id INTEGER NOT NULL,
      coverage_type TEXT NOT NULL CHECK (coverage_type IN ('full', 'partial')),
      PRIMARY KEY (geohash, precision, place_id),
      FOREIGN KEY (place_id) REFERENCES places(id)
    );

    CREATE TABLE IF NOT EXISTS place_geometry(
      place_id INTEGER PRIMARY KEY,
      encoding TEXT NOT NULL DEFAULT 'json',
      geometry BLOB NOT NULL,
      FOREIGN KEY (place_id) REFERENCES places(id)
    );

    CREATE TABLE IF NOT EXISTS place_geohash_lookup(
      geohash TEXT PRIMARY KEY,
      place_id INTEGER NOT NULL,
      FOREIGN KEY (place_id) REFERENCES places(id)
    );

    CREATE INDEX IF NOT EXISTS place_geohash_cover_hash_precision ON place_geohash_cover (geohash, precision);
    CREATE INDEX IF NOT EXISTS place_geohash_cover_place_id ON place_geohash_cover (place_id);
    CREATE INDEX IF NOT EXISTS places_placetype ON places (placetype);
    CREATE INDEX IF NOT EXISTS place_geometry_place_id ON place_geometry (place_id);
    CREATE INDEX IF NOT EXISTS place_geohash_lookup_place_id ON place_geohash_lookup (place_id);
  `)
}

function normalizePlaces(files, opts) {
  var byId = Object.create(null)
  var candidateById = Object.create(null)
  var normalizedCount = 0

  for (var i = 0; i < files.length; i++) {
    var features = readFeatures(files[i])

    for (var j = 0; j < features.length; j++) {
      var place = normalizeFeature(features[j], opts)
      if (!place) continue

      normalizedCount += 1

      if (place.isolationCandidate) {
        candidateById[String(place.id)] = place
      } else {
        byId[String(place.id)] = place
      }

      if (opts.maxPlaces && Object.keys(byId).length >= opts.maxPlaces) {
        break
      }
    }

    if (opts.maxPlaces && Object.keys(byId).length >= opts.maxPlaces) {
      break
    }
  }

  var places = Object.keys(byId)
    .map(function(id) { return byId[id] })
    .sort(function(a, b) { return a.id - b.id })

  var candidates = Object.keys(candidateById)
    .map(function(id) { return candidateById[id] })
    .sort(function(a, b) { return a.id - b.id })

  return {
    places: places,
    candidates: candidates,
    normalizedCount: normalizedCount
  }
}

function promoteIsolatedLocalities(places, candidates, opts) {
  if (!candidates.length) {
    return { places: places, promoted: 0, countryFills: 0 }
  }

  // Build set of geohash cells already claimed by primary places at base precision
  var claimedCells = Object.create(null)
  for (var i = 0; i < places.length; i++) {
    var place = places[i]
    if (place.placetype !== 'locality' && place.placetype !== 'localadmin') continue
    for (var j = 0; j < place.cover.length; j++) {
      var hash = place.cover[j].geohash
      // Claim at base precision: truncate to basePrecision length
      var baseHash = hash.length > opts.basePrecision ? hash.slice(0, opts.basePrecision) : hash
      claimedCells[baseHash] = true
    }
  }

  // Track which countries already have at least one city-like place
  var countriesWithLocality = Object.create(null)
  for (var i = 0; i < places.length; i++) {
    if (isCityPlacetypeCode(places[i].placetypeCode)) {
      countriesWithLocality[places[i].countryId] = true
    }
  }

  // Sort candidates by population descending so higher-pop isolated places win first
  var sortedCandidates = candidates.slice().sort(function(a, b) {
    return b.population - a.population
  })

  var promoted = 0
  var countryFills = 0
  var result = places.slice()

  for (var c = 0; c < sortedCandidates.length; c++) {
    var candidate = sortedCandidates[c]
    var isIsolated = false

    for (var k = 0; k < candidate.cover.length; k++) {
      var hash = candidate.cover[k].geohash
      var baseHash = hash.length > opts.basePrecision ? hash.slice(0, opts.basePrecision) : hash
      if (!claimedCells[baseHash]) {
        isIsolated = true
        break
      }
    }

    if (!isIsolated) continue

    candidate.isolationCandidate = false
    result.push(candidate)
    promoted += 1

    // Mark its cells as claimed
    for (var k = 0; k < candidate.cover.length; k++) {
      var hash = candidate.cover[k].geohash
      var baseHash = hash.length > opts.basePrecision ? hash.slice(0, opts.basePrecision) : hash
      claimedCells[baseHash] = true
    }

    if (!countriesWithLocality[candidate.countryId]) {
      countriesWithLocality[candidate.countryId] = true
      countryFills += 1
    }
  }

  // Ensure every country has at least one locality
  if (opts.ensureCountryLocality) {
    var candidatesByCountry = Object.create(null)
    for (var c = 0; c < sortedCandidates.length; c++) {
      var candidate = sortedCandidates[c]
      if (candidate.isolationCandidate === false) continue // already promoted
      if (!isCityPlacetypeCode(candidate.placetypeCode)) continue
      var cc = candidate.countryId
      if (!candidatesByCountry[cc]) {
        candidatesByCountry[cc] = candidate // first = highest pop (already sorted)
      }
    }

    var countryKeys = Object.keys(candidatesByCountry)
    for (var i = 0; i < countryKeys.length; i++) {
      var cc = countryKeys[i]
      if (countriesWithLocality[cc]) continue

      var best = candidatesByCountry[cc]
      best.isolationCandidate = false
      result.push(best)
      countryFills += 1
      promoted += 1
      countriesWithLocality[cc] = true
    }
  }

  return { places: result, promoted: promoted, countryFills: countryFills }
}

async function writePlaces(db, places, opts, compactLookupRows) {
  await dbExec(db, 'BEGIN')

  try {
    if (opts.replace && opts.indexMode !== 'compact') {
      await dbRun(db, 'DELETE FROM place_geohash_lookup')
      await dbRun(db, 'DELETE FROM place_geohash_cover')
      await dbRun(db, 'DELETE FROM place_geometry')
      await dbRun(db, 'DELETE FROM places')
    }

    var placeStmt = null

    var geometryStmt = null
    var coverStmt = null
    var compactStmt = null

    if (opts.indexMode === 'full') {
      placeStmt = db.prepare(`
        INSERT OR REPLACE INTO places(
          id, name, country_id, admin1_id, placetype,
          centroid_lat, centroid_lon,
          bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
          priority_rank, area, country_name, admin1_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      geometryStmt = db.prepare(`
        INSERT OR REPLACE INTO place_geometry(place_id, encoding, geometry)
        VALUES (?, ?, ?)
      `)

      coverStmt = db.prepare(`
        INSERT OR REPLACE INTO place_geohash_cover(geohash, precision, place_id, coverage_type)
        VALUES (?, ?, ?, ?)
      `)
    } else {
      placeStmt = db.prepare(`
        INSERT OR REPLACE INTO compact_places(
          id, name, country_id, admin1_id, placetype_code,
          latitude, longitude, population, area
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      compactStmt = db.prepare(`
        INSERT OR REPLACE INTO compact_geohash_lookup(geohash, place_id)
        VALUES (?, ?)
      `)
    }

    try {
      for (var i = 0; i < places.length; i++) {
        var place = places[i]

        if (!opts.replace) {
          if (opts.indexMode === 'compact') {
            await dbRun(db, 'DELETE FROM compact_geohash_lookup WHERE place_id = ?', [place.id])
            await dbRun(db, 'DELETE FROM compact_places WHERE id = ?', [place.id])
          } else {
            await dbRun(db, 'DELETE FROM place_geohash_lookup WHERE place_id = ?', [place.id])
            await dbRun(db, 'DELETE FROM place_geohash_cover WHERE place_id = ?', [place.id])
            await dbRun(db, 'DELETE FROM place_geometry WHERE place_id = ?', [place.id])
          }
        }

        if (opts.indexMode === 'compact') {
          await stmtRun(placeStmt, [
            place.id,
            place.name,
            place.countryId,
            place.admin1Id,
            place.placetypeCode,
            place.centroidLat,
            place.centroidLon,
            place.population,
            place.area
          ])
        } else {
          await stmtRun(placeStmt, [
            place.id,
            place.name,
            place.countryId,
            place.admin1Id,
            place.placetype,
            place.centroidLat,
            place.centroidLon,
            place.bboxMinLat,
            place.bboxMinLon,
            place.bboxMaxLat,
            place.bboxMaxLon,
            place.priorityRank,
            place.area,
            place.countryName,
            place.admin1Name
          ])
        }

        if (opts.indexMode === 'full') {
          await stmtRun(geometryStmt, [
            place.id,
            'json',
            JSON.stringify(place.geometry)
          ])

          for (var j = 0; j < place.cover.length; j++) {
            var cell = place.cover[j]
            await stmtRun(coverStmt, [
              cell.geohash,
              cell.precision,
              place.id,
              cell.coverageType
            ])
          }
        }
      }

      if (opts.indexMode === 'compact') {
        for (var rowIndex = 0; rowIndex < compactLookupRows.length; rowIndex++) {
          var row = compactLookupRows[rowIndex]
          await stmtRun(compactStmt, [row.geohash, row.placeId])
        }
      }
    } finally {
      await stmtFinalize(placeStmt)
      if (geometryStmt) await stmtFinalize(geometryStmt)
      if (coverStmt) await stmtFinalize(coverStmt)
      if (compactStmt) await stmtFinalize(compactStmt)
    }

    await dbExec(db, 'COMMIT')
  } catch (err) {
    await dbExec(db, 'ROLLBACK')
    throw err
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

  if (!options.input.length && !options.inputDir.length) {
    throw new Error('Provide at least one --input file or --input-dir')
  }

  if (!Number.isFinite(options.basePrecision) || options.basePrecision < 1) {
    throw new Error('--base-precision must be a positive number')
  }

  if (!Number.isFinite(options.maxPrecision) || options.maxPrecision < options.basePrecision) {
    throw new Error('--max-precision must be >= --base-precision')
  }

  if (options.indexMode !== 'compact' && options.indexMode !== 'full') {
    throw new Error('--index-mode must be either compact or full')
  }

  options.localityMaxPrecision = clampPrecision(options.localityMaxPrecision, options.basePrecision, options.maxPrecision)
  options.localadminMaxPrecision = clampPrecision(options.localadminMaxPrecision, options.basePrecision, options.maxPrecision)
  options.countyMaxPrecision = clampPrecision(options.countyMaxPrecision, options.basePrecision, options.maxPrecision)
  options.regionMaxPrecision = clampPrecision(options.regionMaxPrecision, options.basePrecision, options.maxPrecision)
  if (!Number.isFinite(options.dominantLocalityPopulation) || options.dominantLocalityPopulation <= 0) {
    options.dominantLocalityPopulation = 0
  } else {
    options.dominantLocalityPopulation = Math.trunc(options.dominantLocalityPopulation)
  }
  if (!Number.isFinite(options.dominantLocalityRatio) || options.dominantLocalityRatio < 1) {
    options.dominantLocalityRatio = 1
  }
  if (!Number.isFinite(options.parentLocalityMinShare)) {
    options.parentLocalityMinShare = 0.5
  }
  if (options.parentLocalityMinShare < 0) {
    options.parentLocalityMinShare = 0
  } else if (options.parentLocalityMinShare > 1) {
    options.parentLocalityMinShare = 1
  }
  if (options.regionSparseMaxPrecision !== null) {
    if (!Number.isFinite(options.regionSparseMaxPrecision) || options.regionSparseMaxPrecision < 1) {
      options.regionSparseMaxPrecision = null
    } else {
      options.regionSparseMaxPrecision = Math.trunc(options.regionSparseMaxPrecision)
      if (options.regionSparseMaxPrecision > options.regionMaxPrecision) {
        options.regionSparseMaxPrecision = options.regionMaxPrecision
      }
    }
  }

  var files = collectInputFiles(options)
  if (!files.length) {
    throw new Error('No input files were found after filtering')
  }

  var normalized = normalizePlaces(files, options)
  var primaryPlaces = normalized.places

  if (!primaryPlaces.length && !normalized.candidates.length) {
    throw new Error('No valid locality/localadmin/region records were found in the provided input files')
  }

  var isolation = promoteIsolatedLocalities(primaryPlaces, normalized.candidates, options)
  var dedupedPlaces = isolation.places

  var pruned = pruneContainedLocalities(dedupedPlaces, options.dropContainedLocalities)
  var regionPrune = pruneRedundantRegions(pruned.places)
  var finalPlaces = regionPrune.places
  var compactBuild = options.indexMode === 'compact' ? buildCompactLookupRows(finalPlaces, options) : null
  var compactLookupRows = compactBuild ? compactBuild.rows : []
  var lookupRowsDeferred = 0

  var databasePath = path.resolve(options.database)
  var db = new sqlite3.Database(databasePath)

  try {
    await ensureBoundarySchema(db, options)

    if (compactBuild && !options.replace) {
      var batchPlaceIds = Object.create(null)
      finalPlaces.forEach(function(place) {
        batchPlaceIds[String(place.id)] = true
      })

      var resolved = await resolveExistingCellConflicts(db, compactBuild.rows, compactBuild.placeById, batchPlaceIds, options.homeCellPriority)
      compactLookupRows = resolved.rows
      lookupRowsDeferred = resolved.skipped
    }

    await writePlaces(db, finalPlaces, options, compactLookupRows)

    var coverCount = finalPlaces.reduce(function(total, place) {
      return total + place.cover.length
    }, 0)

    console.log('Boundary index build complete')
    console.log('Database: ' + databasePath)
    console.log('Input files scanned: ' + files.length)
    console.log('Features normalized: ' + normalized.normalizedCount)
    console.log('Primary places (>= min-population): ' + primaryPlaces.length)
    if (normalized.candidates.length) {
      console.log('Isolation candidates evaluated: ' + normalized.candidates.length)
      console.log('Isolated localities promoted: ' + isolation.promoted + ' (country fills: ' + isolation.countryFills + ')')
    }
    console.log('Places after isolation pass: ' + dedupedPlaces.length)
    console.log('Places dropped (contained locality prune): ' + pruned.dropped.length)
    console.log('Regions dropped (redundant with same-name locality): ' + regionPrune.dropped.length)
    console.log('Places written: ' + finalPlaces.length)
    if (options.indexMode === 'compact') {
      console.log('Geohash lookup rows: ' + compactLookupRows.length)
      if (!options.replace) {
        console.log('Lookup rows deferring to better existing matches: ' + lookupRowsDeferred)
      }
    } else {
      console.log('Geohash cover rows: ' + coverCount)
    }
    var modeLabel = 'locality'
    if (options.includeLocaladmin) modeLabel += ' + localadmin'
    if (options.includeCounty) modeLabel += ' + county'
    if (options.includeRegion) modeLabel += ' + region'
    console.log('Mode: ' + modeLabel)
    console.log('Precision: ' + options.basePrecision + ' -> ' + options.maxPrecision)
    console.log('Home cell priority: ' + (options.homeCellPriority ? 'true' : 'false'))
    if (compactBuild) {
      console.log('Home cells kept from a nested foreign cell: ' + (compactBuild.nestedHomeCellFixes || 0))
      console.log('Parent promotions refused over a foreign home cell: ' + (compactBuild.refusedPromotions || 0))
      console.log('Rows kept from a nearer shadowing owner: ' + (compactBuild.shadowedRowsKept || 0))
    }
    console.log('Placetype precision caps: locality=' + options.localityMaxPrecision + ', localadmin=' + options.localadminMaxPrecision + ', county=' + options.countyMaxPrecision + ', region=' + options.regionMaxPrecision)
    if (Number.isFinite(options.regionSparseMaxPrecision) && Number.isFinite(options.regionSparseMinAreaKm2)) {
      console.log('Sparse region rule: area_km2>=' + options.regionSparseMinAreaKm2 + ' => max_precision=' + options.regionSparseMaxPrecision)
    }
    if (options.dominantLocalityPopulation > 0) {
      console.log('Dominant locality rollup: major_population>=' + options.dominantLocalityPopulation + ', ratio>=' + options.dominantLocalityRatio)
    } else {
      console.log('Dominant locality rollup: disabled')
    }
    console.log('Parent locality takeover min share: ' + options.parentLocalityMinShare)
    console.log('Index mode: ' + options.indexMode)
    console.log('Promote locality over region: ' + (options.promoteLocalityOverRegion ? 'true' : 'false'))
    console.log('Min population: ' + options.minPopulation)
    if (Number.isFinite(options.isolationMinPopulation) && options.isolationMinPopulation > 0) {
      console.log('Isolation min population: ' + options.isolationMinPopulation)
    } else {
      console.log('Isolation pass: disabled')
    }
    console.log('Ensure country locality: ' + (options.ensureCountryLocality ? 'true' : 'false'))
  } finally {
    await dbClose(db)
  }
}

main().catch(function(err) {
  console.error(err.message || err)
  process.exit(1)
})
