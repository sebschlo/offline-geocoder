"use strict";

const formatLocation = require('./location').format
const geohash = require('./geohash')
const geometry = require('./geometry')

const SUPPORTED_PLACETYPES = ['locality', 'localadmin', 'region', 'county']
const SUPPORTED_PLACETYPE_CODES = [0, 1, 2, 3]
const PLACEHOLDER_EMPTY = {}

function dbAll(geocoder, query, params) {
  return new Promise(function(resolve, reject) {
    geocoder.db.all(query, params || [], function(err, rows) {
      if (err) reject(err)
      else resolve(rows || [])
    })
  })
}

function pointDistanceScore(latitude, longitude, row) {
  var lat = Number(latitude)
  var lon = Number(longitude)
  var targetLat = Number(row.latitude)
  var targetLon = Number(row.longitude)
  var scale = Math.pow(Math.cos(lat * Math.PI / 180), 2)

  return ((lat - targetLat) * (lat - targetLat)) +
    ((lon - targetLon) * (lon - targetLon) * scale)
}

function placetypeRank(value) {
  if (value === 'locality') return 0
  if (value === 'localadmin') return 1
  if (value === 'region') return 2
  return 3
}

function formatRow(row) {
  if (!row) return PLACEHOLDER_EMPTY
  return formatLocation(row)
}

function executeWithCallback(promise, callback) {
  if (typeof callback !== 'function') {
    return promise
  }

  promise.then(function(result) {
    callback(undefined, result)
  }).catch(function(err) {
    callback(err, undefined)
  })

  return promise
}

function findLegacyCentroidRow(geocoder, latitude, longitude) {
  var query = `SELECT * FROM everything WHERE id IN (
    SELECT feature_id
    FROM coordinates
    WHERE latitude BETWEEN ? - 1.5 AND ? + 1.5
      AND longitude BETWEEN ? - 1.5 AND ? + 1.5
    ORDER BY (
      (? - latitude) * (? - latitude) +
      (? - longitude) * (? - longitude) * ?
    ) ASC
    LIMIT 1
  )`

  var scale = Math.pow(Math.cos(Number(latitude) * Math.PI / 180), 2)

  return dbAll(geocoder, query, [
    latitude, latitude,
    longitude, longitude,
    latitude, latitude,
    longitude, longitude,
    scale
  ]).then(function(rows) {
    return rows[0]
  })
}

function getBoundarySchemaStatus(geocoder) {
  if (geocoder._boundarySchemaStatus) {
    return Promise.resolve(geocoder._boundarySchemaStatus)
  }

  var query = `
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name IN ('compact_places', 'compact_geohash_lookup', 'places', 'place_geohash_lookup', 'place_geohash_cover', 'place_geometry')
  `

  return dbAll(geocoder, query, []).then(function(rows) {
    var names = Object.create(null)
    rows.forEach(function(row) {
      names[row.name] = true
    })

    var status = {
      hasCompactV2: Boolean(names.compact_places && names.compact_geohash_lookup),
      hasCompactLegacy: Boolean(names.places && names.place_geohash_lookup),
      hasFull: Boolean(names.places && names.place_geohash_cover && names.place_geometry)
    }

    geocoder._boundarySchemaStatus = status
    return status
  }).catch(function() {
    var status = { hasCompactV2: false, hasCompactLegacy: false, hasFull: false }
    geocoder._boundarySchemaStatus = status
    return status
  })
}

function reverseHashes(latitude, longitude, basePrecision, maxPrecision) {
  var hashes = []
  for (var precision = maxPrecision; precision >= basePrecision; precision--) {
    hashes.push({
      precision: precision,
      geohash: geohash.encode(latitude, longitude, precision)
    })
  }
  return hashes
}

function fetchCompactBoundaryMatchV2(geocoder, hashes) {
  if (!hashes.length) {
    return Promise.resolve(undefined)
  }

  var placeholders = hashes.map(function() { return '?' }).join(',')
  var params = hashes.map(function(hash) { return hash.geohash })
  var placetypePlaceholders = SUPPORTED_PLACETYPE_CODES.map(function() { return '?' }).join(', ')
  params = params.concat(SUPPORTED_PLACETYPE_CODES)

  var query = `
    SELECT
      l.geohash AS geohash,
      p.id AS id,
      p.name AS name,
      p.country_id AS country_id,
      p.country_id AS country_name,
      p.admin1_id AS admin1_id,
      COALESCE(a.name, '') AS admin1_name,
      p.latitude AS latitude,
      p.longitude AS longitude,
      CASE p.placetype_code
        WHEN 0 THEN 'locality'
        WHEN 1 THEN 'localadmin'
        WHEN 2 THEN 'region'
        WHEN 3 THEN 'county'
        ELSE 'region'
      END AS placetype,
      0 AS priority_rank,
      0 AS area
    FROM compact_geohash_lookup l
    JOIN compact_places p ON p.id = l.place_id
    LEFT JOIN compact_places a ON a.id = p.admin1_id AND a.placetype_code = 2
    WHERE l.geohash IN (${placeholders})
      AND p.placetype_code IN (${placetypePlaceholders})
    ORDER BY
      LENGTH(l.geohash) DESC,
      p.placetype_code ASC,
      p.id ASC
    LIMIT 1
  `

  return dbAll(geocoder, query, params).then(function(rows) {
    return rows[0]
  })
}

function fetchCompactBoundaryMatchLegacy(geocoder, hashes) {
  if (!hashes.length) {
    return Promise.resolve(undefined)
  }

  var placeholders = hashes.map(function() { return '?' }).join(',')
  var params = hashes.map(function(hash) { return hash.geohash })
  var placetypePlaceholders = SUPPORTED_PLACETYPES.map(function() { return '?' }).join(', ')
  params = params.concat(SUPPORTED_PLACETYPES)

  var query = `
    SELECT
      l.geohash AS geohash,
      p.id AS id,
      p.name AS name,
      p.country_id AS country_id,
      COALESCE(c.name, p.country_name, p.country_id, '') AS country_name,
      p.admin1_id AS admin1_id,
      COALESCE(a.name, p.admin1_name, '') AS admin1_name,
      p.centroid_lat AS latitude,
      p.centroid_lon AS longitude,
      p.placetype AS placetype,
      p.priority_rank AS priority_rank,
      p.area AS area
    FROM place_geohash_lookup l
    JOIN places p ON p.id = l.place_id
    LEFT JOIN countries c ON c.id = p.country_id
    LEFT JOIN admin1 a ON a.country_id = p.country_id AND a.id = p.admin1_id
    WHERE l.geohash IN (${placeholders})
      AND p.placetype IN (${placetypePlaceholders})
    ORDER BY
      LENGTH(l.geohash) DESC,
      CASE p.placetype WHEN 'locality' THEN 0 WHEN 'localadmin' THEN 1 ELSE 2 END,
      p.priority_rank ASC,
      p.id ASC
    LIMIT 1
  `

  return dbAll(geocoder, query, params).then(function(rows) {
    return rows[0]
  })
}

function fetchBoundaryCandidates(geocoder, hashes) {
  if (!hashes.length) {
    return Promise.resolve([])
  }

  var clauses = []
  var params = []
  for (var i = 0; i < hashes.length; i++) {
    clauses.push('(g.geohash = ? AND g.precision = ?)')
    params.push(hashes[i].geohash)
    params.push(hashes[i].precision)
  }
  var placetypePlaceholders = SUPPORTED_PLACETYPES.map(function() { return '?' }).join(', ')

  var query = `
    SELECT DISTINCT
      p.id AS id,
      p.name AS name,
      p.country_id AS country_id,
      COALESCE(c.name, p.country_name, p.country_id, '') AS country_name,
      p.admin1_id AS admin1_id,
      COALESCE(a.name, p.admin1_name, '') AS admin1_name,
      p.centroid_lat AS latitude,
      p.centroid_lon AS longitude,
      p.placetype AS placetype,
      p.priority_rank AS priority_rank,
      p.area AS area,
      p.bbox_min_lat AS bbox_min_lat,
      p.bbox_min_lon AS bbox_min_lon,
      p.bbox_max_lat AS bbox_max_lat,
      p.bbox_max_lon AS bbox_max_lon
    FROM place_geohash_cover g
    JOIN places p ON p.id = g.place_id
    LEFT JOIN countries c ON c.id = p.country_id
    LEFT JOIN admin1 a ON a.country_id = p.country_id AND a.id = p.admin1_id
    WHERE (${clauses.join(' OR ')})
      AND p.placetype IN (${placetypePlaceholders})
  `

  params = params.concat(SUPPORTED_PLACETYPES)
  return dbAll(geocoder, query, params)
}

function hasPointInPlaceBbox(place, latitude, longitude) {
  return geometry.bboxContainsPoint({
    minLat: Number(place.bbox_min_lat),
    minLon: Number(place.bbox_min_lon),
    maxLat: Number(place.bbox_max_lat),
    maxLon: Number(place.bbox_max_lon)
  }, latitude, longitude)
}

function loadPlaceGeometries(geocoder, placeIds) {
  if (!placeIds.length) {
    return Promise.resolve(Object.create(null))
  }

  var cache = geocoder._boundaryGeometryCache
  if (!cache) {
    cache = Object.create(null)
    geocoder._boundaryGeometryCache = cache
  }

  var missing = []
  for (var i = 0; i < placeIds.length; i++) {
    var key = String(placeIds[i])
    if (!cache[key]) {
      missing.push(placeIds[i])
    }
  }

  if (!missing.length) {
    return Promise.resolve(cache)
  }

  var placeholders = missing.map(function() { return '?' }).join(',')
  var query = `SELECT place_id, encoding, geometry FROM place_geometry WHERE place_id IN (${placeholders})`

  return dbAll(geocoder, query, missing).then(function(rows) {
    rows.forEach(function(row) {
      var key = String(row.place_id)
      if (cache[key]) {
        return
      }

      var raw = row.geometry
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
        raw = raw.toString('utf8')
      }

      if (typeof raw !== 'string') {
        raw = String(raw)
      }

      try {
        cache[key] = geometry.normalizeGeometry(JSON.parse(raw))
      } catch (err) {
        cache[key] = null
      }
    })

    return cache
  })
}

function sortContainedPlaces(matches) {
  return matches.sort(function(a, b) {
    var typeRankA = placetypeRank(a.placetype)
    var typeRankB = placetypeRank(b.placetype)
    if (typeRankA !== typeRankB) {
      return typeRankA - typeRankB
    }

    var areaA = Number(a.area)
    var areaB = Number(b.area)
    if (!Number.isFinite(areaA)) areaA = Infinity
    if (!Number.isFinite(areaB)) areaB = Infinity
    if (areaA !== areaB) {
      return areaA - areaB
    }

    var priorityA = Number(a.priority_rank)
    var priorityB = Number(b.priority_rank)
    if (!Number.isFinite(priorityA)) priorityA = Number.MAX_SAFE_INTEGER
    if (!Number.isFinite(priorityB)) priorityB = Number.MAX_SAFE_INTEGER
    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    var idA = String(a.id)
    var idB = String(b.id)
    if (idA < idB) return -1
    if (idA > idB) return 1
    return 0
  })
}

function pickNearest(rows, latitude, longitude) {
  if (!rows.length) return undefined

  var sorted = rows.slice().sort(function(a, b) {
    var scoreA = pointDistanceScore(latitude, longitude, a)
    var scoreB = pointDistanceScore(latitude, longitude, b)

    if (scoreA !== scoreB) {
      return scoreA - scoreB
    }

    var typeRankA = placetypeRank(a.placetype)
    var typeRankB = placetypeRank(b.placetype)
    if (typeRankA !== typeRankB) {
      return typeRankA - typeRankB
    }

    var priorityA = Number(a.priority_rank)
    var priorityB = Number(b.priority_rank)
    if (!Number.isFinite(priorityA)) priorityA = Number.MAX_SAFE_INTEGER
    if (!Number.isFinite(priorityB)) priorityB = Number.MAX_SAFE_INTEGER
    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    var idA = String(a.id)
    var idB = String(b.id)
    if (idA < idB) return -1
    if (idA > idB) return 1
    return 0
  })

  return sorted[0]
}

function fetchNearestBoundaryByRegion(geocoder, latitude, longitude, region) {
  var where = [
    'p.placetype IN (' + SUPPORTED_PLACETYPES.map(function() { return '?' }).join(', ') + ')'
  ]
  var params = SUPPORTED_PLACETYPES.slice()

  if (region && region.countryId) {
    where.push('p.country_id = ?')
    params.push(region.countryId)
  }

  if (region && region.admin1Id !== undefined && region.admin1Id !== null) {
    where.push('p.admin1_id = ?')
    params.push(region.admin1Id)
  }

  var scale = Math.pow(Math.cos(Number(latitude) * Math.PI / 180), 2)

  var query = `
    SELECT
      p.id AS id,
      p.name AS name,
      p.country_id AS country_id,
      COALESCE(c.name, p.country_name, p.country_id, '') AS country_name,
      p.admin1_id AS admin1_id,
      COALESCE(a.name, p.admin1_name, '') AS admin1_name,
      p.centroid_lat AS latitude,
      p.centroid_lon AS longitude,
      p.placetype AS placetype,
      p.priority_rank AS priority_rank,
      p.area AS area
    FROM places p
    LEFT JOIN countries c ON c.id = p.country_id
    LEFT JOIN admin1 a ON a.country_id = p.country_id AND a.id = p.admin1_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      ((? - p.centroid_lat) * (? - p.centroid_lat) +
      (? - p.centroid_lon) * (? - p.centroid_lon) * ?) ASC,
      CASE p.placetype WHEN 'locality' THEN 0 WHEN 'localadmin' THEN 1 ELSE 2 END,
      p.priority_rank ASC,
      p.id ASC
    LIMIT 1
  `

  params.push(latitude, latitude, longitude, longitude, scale)

  return dbAll(geocoder, query, params).then(function(rows) {
    return rows[0]
  })
}

function fetchNearestCompactByRegionV2(geocoder, latitude, longitude, region) {
  var where = [
    'p.placetype_code IN (' + SUPPORTED_PLACETYPE_CODES.map(function() { return '?' }).join(', ') + ')'
  ]
  var params = SUPPORTED_PLACETYPE_CODES.slice()

  if (region && region.countryId) {
    where.push('p.country_id = ?')
    params.push(region.countryId)
  }

  if (region && region.admin1Id !== undefined && region.admin1Id !== null) {
    where.push('p.admin1_id = ?')
    params.push(region.admin1Id)
  }

  var scale = Math.pow(Math.cos(Number(latitude) * Math.PI / 180), 2)

  var query = `
    SELECT
      p.id AS id,
      p.name AS name,
      p.country_id AS country_id,
      p.country_id AS country_name,
      p.admin1_id AS admin1_id,
      COALESCE(a.name, '') AS admin1_name,
      p.latitude AS latitude,
      p.longitude AS longitude,
      CASE p.placetype_code
        WHEN 0 THEN 'locality'
        WHEN 1 THEN 'localadmin'
        WHEN 2 THEN 'region'
        WHEN 3 THEN 'county'
        ELSE 'region'
      END AS placetype,
      0 AS priority_rank,
      0 AS area
    FROM compact_places p
    LEFT JOIN compact_places a ON a.id = p.admin1_id AND a.placetype_code = 2
    WHERE ${where.join(' AND ')}
    ORDER BY
      ((? - p.latitude) * (? - p.latitude) +
      (? - p.longitude) * (? - p.longitude) * ?) ASC,
      p.placetype_code ASC,
      p.id ASC
    LIMIT 1
  `

  params.push(latitude, latitude, longitude, longitude, scale)

  return dbAll(geocoder, query, params).then(function(rows) {
    return rows[0]
  })
}

function attachDebug(geocoder, payload, reason) {
  if (!geocoder.reverseDebug || !payload || !Object.keys(payload).length) {
    return payload
  }

  var result = Object.assign({}, payload)
  result._debug = {
    mode: 'boundary',
    reason: reason
  }
  return result
}

function fallbackNearestBoundary(geocoder, latitude, longitude, mode) {
  var fetchNearest = mode === 'compact_v2' ? fetchNearestCompactByRegionV2 : fetchNearestBoundaryByRegion

  return fetchNearest(geocoder, latitude, longitude, null)
    .then(function(globalNearest) {
      if (!globalNearest) {
        return {
          row: undefined,
          reason: 'no_boundary_places'
        }
      }

      return fetchNearest(geocoder, latitude, longitude, {
        countryId: globalNearest.country_id,
        admin1Id: globalNearest.admin1_id
      }).then(function(regionalNearest) {
        return {
          row: regionalNearest || globalNearest,
          reason: 'regional_centroid_fallback'
        }
      })
    })
}

function tryCompactBoundaryLookup(geocoder, latitude, longitude, hashes, mode) {
  var fetchCompact = mode === 'compact_v2' ? fetchCompactBoundaryMatchV2 : fetchCompactBoundaryMatchLegacy

  return fetchCompact(geocoder, hashes).then(function(row) {
    if (row) {
      return {
        row: row,
        reason: 'geohash_lookup'
      }
    }
    return {
      row: undefined,
      reason: 'no_compact_match'
    }
  })
}

function tryFullBoundaryLookup(geocoder, latitude, longitude, hashes) {
  return fetchBoundaryCandidates(geocoder, hashes)
    .then(function(candidates) {
      var bboxCandidates = candidates.filter(function(candidate) {
        return hasPointInPlaceBbox(candidate, latitude, longitude)
      })

      if (!bboxCandidates.length) {
        return {
          row: pickNearest(candidates, latitude, longitude),
          reason: 'boundary_centroid_fallback'
        }
      }

      var candidateIds = bboxCandidates.map(function(candidate) { return candidate.id })
      return loadPlaceGeometries(geocoder, candidateIds)
        .then(function(geometryById) {
          var contained = bboxCandidates.filter(function(candidate) {
            var polygon = geometryById[String(candidate.id)]
            if (!polygon) return false
            return geometry.pointInGeometry(polygon, latitude, longitude)
          })

          if (contained.length) {
            var selected = sortContainedPlaces(contained)[0]
            return {
              row: selected,
              reason: 'polygon_contains'
            }
          }

          var nearestInCandidates = pickNearest(bboxCandidates, latitude, longitude)
          if (nearestInCandidates) {
            return {
              row: nearestInCandidates,
              reason: 'bbox_candidate_centroid_fallback'
            }
          }

          return {
            row: undefined,
            reason: 'no_boundary_candidate'
          }
        })
    })
    .then(function(result) {
      if (result && result.row) {
        return result
      }

      return fallbackNearestBoundary(geocoder, latitude, longitude, 'full')
    })
}

function tryBoundaryLookup(geocoder, latitude, longitude) {
  return getBoundarySchemaStatus(geocoder).then(function(status) {
    if (!status.hasCompactV2 && !status.hasCompactLegacy && !status.hasFull) {
      return undefined
    }

    var options = geocoder.boundaryOptions || {}
    var basePrecision = Number(options.basePrecision || 4)
    var maxPrecision = Number(options.maxPrecision || 7)
    if (basePrecision < 1) basePrecision = 1
    if (maxPrecision < basePrecision) maxPrecision = basePrecision

    var hashes = reverseHashes(latitude, longitude, basePrecision, maxPrecision)

    var compactMode = status.hasCompactV2 ? 'compact_v2' : (status.hasCompactLegacy ? 'compact_legacy' : null)

    if (compactMode) {
      return tryCompactBoundaryLookup(geocoder, latitude, longitude, hashes, compactMode)
        .then(function(result) {
          if (result && result.row) {
            return result
          }

          if (status.hasFull) {
            return tryFullBoundaryLookup(geocoder, latitude, longitude, hashes)
          }

          return fallbackNearestBoundary(geocoder, latitude, longitude, compactMode)
        })
    }

    return tryFullBoundaryLookup(geocoder, latitude, longitude, hashes)
  })
}

function findFeature(geocoder, latitude, longitude) {
  var mode = geocoder.reverseMode || 'centroid'

  if (mode !== 'boundary') {
    return findLegacyCentroidRow(geocoder, latitude, longitude).then(function(row) {
      return formatRow(row)
    })
  }

  return tryBoundaryLookup(geocoder, latitude, longitude)
    .then(function(boundaryResult) {
      if (boundaryResult && boundaryResult.row) {
        return attachDebug(geocoder, formatRow(boundaryResult.row), boundaryResult.reason)
      }

      return findLegacyCentroidRow(geocoder, latitude, longitude)
        .then(function(row) {
          return attachDebug(geocoder, formatRow(row), 'legacy_centroid_fallback')
        })
    })
}

function Reverse(geocoder, latitude, longitude, callback) {
  return executeWithCallback(findFeature(geocoder, latitude, longitude), callback)
}

module.exports = Reverse;
