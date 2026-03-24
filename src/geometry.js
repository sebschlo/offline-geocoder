"use strict";

const EPSILON = 1e-12

function markNormalized(value) {
  Object.defineProperty(value, '__normalized', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false
  })
  return value
}

function setCachedBbox(value, bbox) {
  Object.defineProperty(value, '__bbox', {
    value: bbox,
    enumerable: false,
    configurable: true,
    writable: true
  })
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return []

  var normalized = ring.map(function(point) {
    return [Number(point[0]), Number(point[1])]
  })

  var first = normalized[0]
  var last = normalized[normalized.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    normalized.push([first[0], first[1]])
  }

  return normalized
}

function normalizeGeometry(geometry) {
  if (!geometry || !geometry.type || !geometry.coordinates) {
    throw new Error('Invalid geometry payload')
  }

  if (geometry.type === 'MultiPolygon' && geometry.__normalized) {
    return geometry
  }

  if (geometry.type === 'Polygon') {
    return markNormalized({
      type: 'MultiPolygon',
      coordinates: [geometry.coordinates.map(closeRing)]
    })
  }

  if (geometry.type === 'MultiPolygon') {
    return markNormalized({
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map(function(polygon) {
        return polygon.map(closeRing)
      })
    })
  }

  throw new Error('Unsupported geometry type: ' + geometry.type)
}

function geometryBbox(geometry) {
  var normalized = normalizeGeometry(geometry)
  if (normalized.__bbox) {
    return normalized.__bbox
  }

  var minLat = Infinity
  var minLon = Infinity
  var maxLat = -Infinity
  var maxLon = -Infinity

  normalized.coordinates.forEach(function(polygon) {
    polygon.forEach(function(ring) {
      ring.forEach(function(point) {
        var lon = Number(point[0])
        var lat = Number(point[1])

        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
      })
    })
  })

  var bbox = {
    minLat: minLat,
    minLon: minLon,
    maxLat: maxLat,
    maxLon: maxLon
  }

  setCachedBbox(normalized, bbox)
  return bbox
}

function signedRingArea(ring) {
  var area = 0
  for (var i = 0; i < ring.length - 1; i++) {
    var current = ring[i]
    var next = ring[i + 1]
    area += (current[0] * next[1]) - (next[0] * current[1])
  }
  return area / 2
}

function geometryArea(geometry) {
  var normalized = normalizeGeometry(geometry)
  var total = 0

  normalized.coordinates.forEach(function(polygon) {
    if (!polygon[0] || polygon[0].length < 4) return

    var polygonArea = Math.abs(signedRingArea(polygon[0]))
    for (var i = 1; i < polygon.length; i++) {
      polygonArea -= Math.abs(signedRingArea(polygon[i]))
    }

    total += Math.max(0, polygonArea)
  })

  return total
}

function almostEqual(a, b) {
  return Math.abs(a - b) <= EPSILON
}

function pointOnSegment(point, a, b) {
  var sqLen = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])
  if (sqLen <= EPSILON) {
    return almostEqual(point[0], a[0]) && almostEqual(point[1], a[1])
  }

  var cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1])
  if (Math.abs(cross) > EPSILON) {
    return false
  }

  var dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])
  if (dot < -EPSILON) {
    return false
  }

  if (dot - sqLen > EPSILON) {
    return false
  }

  return true
}

function pointInRing(point, ring) {
  if (!ring || ring.length < 4) return false

  var inside = false
  var last = ring.length - 1

  for (var i = 0, j = last - 1; i < last; j = i++) {
    var a = ring[i]
    var b = ring[j]

    if (pointOnSegment(point, a, b)) {
      return true
    }

    var yi = a[1]
    var yj = b[1]
    var xi = a[0]
    var xj = b[0]

    var intersects = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || EPSILON) + xi)

    if (intersects) inside = !inside
  }

  return inside
}

function pointInPolygon(point, polygon) {
  if (!polygon[0] || !pointInRing(point, polygon[0])) {
    return false
  }

  for (var i = 1; i < polygon.length; i++) {
    if (pointInRing(point, polygon[i])) {
      return false
    }
  }

  return true
}

function pointInGeometry(geometry, latitude, longitude) {
  var normalized = normalizeGeometry(geometry)
  var point = [Number(longitude), Number(latitude)]

  for (var i = 0; i < normalized.coordinates.length; i++) {
    if (pointInPolygon(point, normalized.coordinates[i])) {
      return true
    }
  }

  return false
}

function bboxContainsPoint(bbox, latitude, longitude) {
  return Number(latitude) >= bbox.minLat && Number(latitude) <= bbox.maxLat &&
    Number(longitude) >= bbox.minLon && Number(longitude) <= bbox.maxLon
}

function bboxIntersects(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat)
}

function bboxContainsBbox(outer, inner) {
  return outer.minLat <= inner.minLat &&
    outer.minLon <= inner.minLon &&
    outer.maxLat >= inner.maxLat &&
    outer.maxLon >= inner.maxLon
}

function orientation(a, b, c) {
  var value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])
  if (almostEqual(value, 0)) return 0
  return value > 0 ? 1 : 2
}

function segmentsIntersect(a, b, c, d) {
  var o1 = orientation(a, b, c)
  var o2 = orientation(a, b, d)
  var o3 = orientation(c, d, a)
  var o4 = orientation(c, d, b)

  if (o1 !== o2 && o3 !== o4) {
    return true
  }

  if (o1 === 0 && pointOnSegment(c, a, b)) return true
  if (o2 === 0 && pointOnSegment(d, a, b)) return true
  if (o3 === 0 && pointOnSegment(a, c, d)) return true
  if (o4 === 0 && pointOnSegment(b, c, d)) return true
  return false
}

function segmentIntersectsRect(a, b, rect) {
  var rectPoints = [
    [rect.minLon, rect.minLat],
    [rect.maxLon, rect.minLat],
    [rect.maxLon, rect.maxLat],
    [rect.minLon, rect.maxLat]
  ]

  if (bboxContainsPoint(rect, a[1], a[0]) || bboxContainsPoint(rect, b[1], b[0])) {
    return true
  }

  for (var i = 0; i < rectPoints.length; i++) {
    var p1 = rectPoints[i]
    var p2 = rectPoints[(i + 1) % rectPoints.length]
    if (segmentsIntersect(a, b, p1, p2)) {
      return true
    }
  }

  return false
}

function pointOnRectBoundary(rect, point) {
  var lon = point[0]
  var lat = point[1]

  var onVertical = (almostEqual(lon, rect.minLon) || almostEqual(lon, rect.maxLon)) &&
    lat >= rect.minLat - EPSILON && lat <= rect.maxLat + EPSILON
  var onHorizontal = (almostEqual(lat, rect.minLat) || almostEqual(lat, rect.maxLat)) &&
    lon >= rect.minLon - EPSILON && lon <= rect.maxLon + EPSILON

  return onVertical || onHorizontal
}

function anyVertexInsideRect(geometry, rect, includeBoundary) {
  var normalized = normalizeGeometry(geometry)

  for (var i = 0; i < normalized.coordinates.length; i++) {
    var polygon = normalized.coordinates[i]
    for (var j = 0; j < polygon.length; j++) {
      var ring = polygon[j]
      for (var k = 0; k < ring.length; k++) {
        var point = ring[k]
        if (bboxContainsPoint(rect, point[1], point[0])) {
          if (!includeBoundary && pointOnRectBoundary(rect, point)) {
            continue
          }
          return true
        }
      }
    }
  }

  return false
}

function anyEdgeIntersectsRect(geometry, rect) {
  var normalized = normalizeGeometry(geometry)

  for (var i = 0; i < normalized.coordinates.length; i++) {
    var polygon = normalized.coordinates[i]
    for (var j = 0; j < polygon.length; j++) {
      var ring = polygon[j]
      for (var k = 0; k < ring.length - 1; k++) {
        if (segmentIntersectsRect(ring[k], ring[k + 1], rect)) {
          return true
        }
      }
    }
  }

  return false
}

function classifyCell(geometry, cellBbox) {
  var bounds = geometryBbox(geometry)
  if (!bboxIntersects(bounds, cellBbox)) {
    return 'outside'
  }

  var corners = [
    [cellBbox.minLon, cellBbox.minLat],
    [cellBbox.maxLon, cellBbox.minLat],
    [cellBbox.maxLon, cellBbox.maxLat],
    [cellBbox.minLon, cellBbox.maxLat]
  ]

  var cornersInside = 0
  for (var i = 0; i < corners.length; i++) {
    if (pointInGeometry(geometry, corners[i][1], corners[i][0])) {
      cornersInside += 1
    }
  }

  var centerLat = (cellBbox.minLat + cellBbox.maxLat) / 2
  var centerLon = (cellBbox.minLon + cellBbox.maxLon) / 2
  var centerInside = pointInGeometry(geometry, centerLat, centerLon)
  var hasInnerVertex = anyVertexInsideRect(geometry, cellBbox, false)

  if (cornersInside === 4 && centerInside && !hasInnerVertex) {
    return 'full'
  }

  if (anyEdgeIntersectsRect(geometry, cellBbox)) {
    return 'partial'
  }

  if (anyVertexInsideRect(geometry, cellBbox, true)) {
    return 'partial'
  }

  if (cornersInside > 0) {
    return 'partial'
  }

  if (centerInside) {
    return 'partial'
  }

  return 'outside'
}

function geometryContainsGeometry(containerGeometry, candidateGeometry) {
  var container = normalizeGeometry(containerGeometry)
  var candidate = normalizeGeometry(candidateGeometry)

  if (!bboxContainsBbox(geometryBbox(container), geometryBbox(candidate))) {
    return false
  }

  for (var i = 0; i < candidate.coordinates.length; i++) {
    var polygon = candidate.coordinates[i]
    for (var j = 0; j < polygon.length; j++) {
      var ring = polygon[j]
      var limit = ring.length > 1 ? ring.length - 1 : ring.length
      for (var k = 0; k < limit; k++) {
        var point = ring[k]
        if (!pointInGeometry(container, point[1], point[0])) {
          return false
        }
      }
    }
  }

  return true
}

module.exports = {
  normalizeGeometry: normalizeGeometry,
  geometryBbox: geometryBbox,
  geometryArea: geometryArea,
  pointInGeometry: pointInGeometry,
  bboxContainsPoint: bboxContainsPoint,
  bboxIntersects: bboxIntersects,
  bboxContainsBbox: bboxContainsBbox,
  classifyCell: classifyCell,
  geometryContainsGeometry: geometryContainsGeometry
}
