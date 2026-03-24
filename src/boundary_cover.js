"use strict";

const geohash = require('./geohash')
const geometry = require('./geometry')

const EPSILON = 1e-12

function clampLatitude(value) {
  var lat = Number(value)
  if (lat > 90) lat = 90
  if (lat < -90) lat = -90
  return lat
}

function clampLongitude(value) {
  var lon = Number(value)
  if (lon > 180) lon = 180
  if (lon < -180) lon = -180
  return lon
}

function seedGeohashesForBbox(bbox, precision) {
  var size = geohash.cellSize(precision)
  var minLat = clampLatitude(bbox.minLat)
  var maxLat = clampLatitude(bbox.maxLat - EPSILON)
  var minLon = clampLongitude(bbox.minLon)
  var maxLon = clampLongitude(bbox.maxLon - EPSILON)

  var latStart = Math.floor((minLat + 90) / size.lat)
  var latEnd = Math.floor((maxLat + 90) / size.lat)
  var lonStart = Math.floor((minLon + 180) / size.lon)
  var lonEnd = Math.floor((maxLon + 180) / size.lon)

  var hashes = Object.create(null)

  for (var latIndex = latStart; latIndex <= latEnd; latIndex++) {
    var centerLat = -90 + (latIndex + 0.5) * size.lat
    for (var lonIndex = lonStart; lonIndex <= lonEnd; lonIndex++) {
      var centerLon = -180 + (lonIndex + 0.5) * size.lon
      hashes[geohash.encode(centerLat, centerLon, precision)] = true
    }
  }

  return Object.keys(hashes)
}

function buildGeohashCoverForGeometry(inputGeometry, options) {
  var opts = options || {}
  var basePrecision = Number(opts.basePrecision || 4)
  var maxPrecision = Number(opts.maxPrecision || 7)

  if (basePrecision < 1) basePrecision = 1
  if (maxPrecision < basePrecision) maxPrecision = basePrecision

  var normalized = geometry.normalizeGeometry(inputGeometry)
  var bounds = geometry.geometryBbox(normalized)
  var seeds = seedGeohashesForBbox(bounds, basePrecision)
  var terminal = Object.create(null)

  function walk(hash, precision) {
    var cellBbox = geohash.decodeBbox(hash)
    var status = geometry.classifyCell(normalized, cellBbox)

    if (status === 'outside') {
      return
    }

    if (status === 'partial' && precision < maxPrecision) {
      geohash.children(hash).forEach(function(child) {
        walk(child, precision + 1)
      })
      return
    }

    terminal[hash + '|' + precision] = {
      geohash: hash,
      precision: precision,
      coverageType: status
    }
  }

  seeds.forEach(function(hash) {
    walk(hash, basePrecision)
  })

  return Object.keys(terminal)
    .map(function(key) { return terminal[key] })
    .sort(function(a, b) {
      if (a.precision !== b.precision) return a.precision - b.precision
      if (a.geohash < b.geohash) return -1
      if (a.geohash > b.geohash) return 1
      return 0
    })
}

module.exports = {
  buildGeohashCoverForGeometry: buildGeohashCoverForGeometry,
  seedGeohashesForBbox: seedGeohashesForBbox
}
