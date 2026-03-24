"use strict";

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const BASE32_MAP = Object.create(null)
for (var i = 0; i < BASE32.length; i++) {
  BASE32_MAP[BASE32.charAt(i)] = i
}

function normalizeLatitude(value) {
  var latitude = Number(value)
  if (Number.isNaN(latitude)) {
    latitude = 0
  }
  if (latitude > 90) latitude = 90
  if (latitude < -90) latitude = -90
  return latitude
}

function normalizeLongitude(value) {
  var longitude = Number(value)
  if (Number.isNaN(longitude)) {
    longitude = 0
  }

  while (longitude < -180) longitude += 360
  while (longitude > 180) longitude -= 360

  if (longitude === 180) {
    longitude = 179.99999999999997
  }

  return longitude
}

function encode(latitude, longitude, precision) {
  var targetPrecision = Number(precision)
  if (!targetPrecision || targetPrecision < 1) {
    targetPrecision = 1
  }

  var lat = normalizeLatitude(latitude)
  var lon = normalizeLongitude(longitude)

  var latMin = -90
  var latMax = 90
  var lonMin = -180
  var lonMax = 180
  var hash = ''
  var bit = 0
  var ch = 0
  var evenBit = true

  while (hash.length < targetPrecision) {
    if (evenBit) {
      var lonMid = (lonMin + lonMax) / 2
      if (lon >= lonMid) {
        ch = (ch << 1) + 1
        lonMin = lonMid
      } else {
        ch = (ch << 1)
        lonMax = lonMid
      }
    } else {
      var latMid = (latMin + latMax) / 2
      if (lat >= latMid) {
        ch = (ch << 1) + 1
        latMin = latMid
      } else {
        ch = (ch << 1)
        latMax = latMid
      }
    }

    evenBit = !evenBit
    bit += 1

    if (bit === 5) {
      hash += BASE32.charAt(ch)
      bit = 0
      ch = 0
    }
  }

  return hash
}

function decodeBbox(hash) {
  var value = String(hash || '').toLowerCase()
  var latMin = -90
  var latMax = 90
  var lonMin = -180
  var lonMax = 180
  var evenBit = true

  for (var i = 0; i < value.length; i++) {
    var ch = value.charAt(i)
    if (BASE32_MAP[ch] === undefined) {
      throw new Error('Invalid geohash character: ' + ch)
    }

    var current = BASE32_MAP[ch]
    for (var mask = 16; mask > 0; mask >>= 1) {
      if (evenBit) {
        var lonMid = (lonMin + lonMax) / 2
        if (current & mask) {
          lonMin = lonMid
        } else {
          lonMax = lonMid
        }
      } else {
        var latMid = (latMin + latMax) / 2
        if (current & mask) {
          latMin = latMid
        } else {
          latMax = latMid
        }
      }

      evenBit = !evenBit
    }
  }

  return {
    minLat: latMin,
    minLon: lonMin,
    maxLat: latMax,
    maxLon: lonMax
  }
}

function cellSize(precision) {
  var p = Math.max(1, Number(precision) || 1)
  var totalBits = p * 5
  var lonBits = Math.ceil(totalBits / 2)
  var latBits = Math.floor(totalBits / 2)

  return {
    lat: 180 / Math.pow(2, latBits),
    lon: 360 / Math.pow(2, lonBits)
  }
}

function children(hash) {
  var prefix = String(hash || '')
  var values = []
  for (var i = 0; i < BASE32.length; i++) {
    values.push(prefix + BASE32.charAt(i))
  }
  return values
}

module.exports = {
  encode: encode,
  decodeBbox: decodeBbox,
  cellSize: cellSize,
  children: children,
  base32: BASE32
}
