'use strict'

var selectAll =
  'SELECT id, name, admin1_id, admin1_name,' +
  ' country_id, country_name, latitude, longitude' +
  ' FROM everything'

function normalizeId(value) {
  if (typeof value === 'string') {
    var match = /^geonames:(\d+)$/i.exec(value.trim())
    if (match) return Number(match[1])
    return Number(value)
  }
  return value
}

// Construct the formatted name consisting of the name, admin1 name and
// country name. Some features don't have an admin1, and others may have the
// same name as the feature, so this handles that.
function formatRow(row) {
  if (!row) return undefined

  var parts = [row.name]
  if (row.admin1_name && row.admin1_name !== row.name) {
    parts.push(row.admin1_name)
  }
  parts.push(row.country_name)

  return {
    id: row.id,
    name: row.name,
    formatted: parts.join(', '),
    country: { id: row.country_id, name: row.country_name },
    admin1: { id: row.admin1_id, name: row.admin1_name },
    coordinates: { latitude: row.latitude, longitude: row.longitude }
  }
}

function createGeocoder(adapter) {
  if (!adapter || typeof adapter.all !== 'function') {
    throw new Error('Adapter must provide an all(sql, params) method')
  }

  // Databases generated before the schema update won't have the asciiname
  // or population columns needed for forward search. We probe once on the
  // first forward() call and cache the result.
  var forwardSupported = null

  function checkForwardSupport() {
    if (forwardSupported !== null) return Promise.resolve(forwardSupported)
    return adapter.all('SELECT asciiname FROM everything LIMIT 0', [])
      .then(function () { forwardSupported = true; return true })
      .catch(function () { forwardSupported = false; return false })
  }

  function one(sql, params) {
    return adapter.all(sql, params || []).then(function (rows) {
      return rows[0]
    })
  }

  // This finds the closest feature based upon Pythagoras's theorem. It is an
  // approximation, and won't provide results as accurate as the haversine
  // formula, but trades that for performance. For our use case this is good
  // enough as the data is just an approximation of the centre point of a
  // feature.
  //
  // The scale parameter accounts for the fact that 1 degree in longitude is
  // different at the poles vs the equator.
  //
  // Based upon http://stackoverflow.com/a/7261601/155715
  function reverse(latitude, longitude) {
    var scale = Math.pow(Math.cos(latitude * Math.PI / 180), 2)

    return one(
      selectAll + ' WHERE id IN (' +
        'SELECT feature_id FROM coordinates ' +
        'WHERE latitude BETWEEN ? - 1.5 AND ? + 1.5 ' +
        'AND longitude BETWEEN ? - 1.5 AND ? + 1.5 ' +
        'ORDER BY ' +
          '((? - latitude) * (? - latitude)) + ' +
          '((? - longitude) * (? - longitude) * ?) ' +
        'LIMIT 1' +
      ') LIMIT 1',
      [latitude, latitude, longitude, longitude,
       latitude, latitude, longitude, longitude, scale]
    ).then(function (row) {
      return row ? formatRow(row) : {}
    })
  }

  function find(locationId) {
    return one(selectAll + ' WHERE id = ? LIMIT 1', [normalizeId(locationId)])
      .then(formatRow)
  }

  // Forward geocoding: tries an exact match on name/asciiname first, then
  // falls back to prefix and substring matching. Requires the updated schema
  // with asciiname and population columns — returns undefined on old databases.
  function forward(query) {
    var q = typeof query === 'string' ? query.trim() : ''
    if (!q) return Promise.resolve(undefined)

    return checkForwardSupport().then(function (supported) {
      if (!supported) return undefined

      return one(
        selectAll +
        ' WHERE name = ? COLLATE NOCASE OR asciiname = ? COLLATE NOCASE' +
        ' ORDER BY' +
        '   CASE WHEN name = ? COLLATE NOCASE THEN 0' +
        '        WHEN asciiname = ? COLLATE NOCASE THEN 1' +
        '        ELSE 2 END,' +
        '   population DESC, id ASC' +
        ' LIMIT 1',
        [q, q, q, q]
      ).then(function (exact) {
        if (exact) return formatRow(exact)

        var prefix = q + '%'
        var contains = '%' + q + '%'
        return one(
          selectAll +
          ' WHERE name LIKE ? COLLATE NOCASE' +
          '    OR name LIKE ? COLLATE NOCASE' +
          '    OR asciiname LIKE ? COLLATE NOCASE' +
          '    OR asciiname LIKE ? COLLATE NOCASE' +
          ' ORDER BY' +
          '   CASE WHEN name LIKE ? COLLATE NOCASE THEN 0' +
          '        WHEN asciiname LIKE ? COLLATE NOCASE THEN 1' +
          '        ELSE 2 END,' +
          '   population DESC, LENGTH(name) ASC, id ASC' +
          ' LIMIT 1',
          [prefix, contains, prefix, contains, prefix, prefix]
        ).then(formatRow)
      })
    })
  }

  var locationApi = { find: find }

  function location() {
    return locationApi
  }
  location.find = find

  return {
    reverse: reverse,
    forward: forward,
    location: location,
    close: function () {
      return typeof adapter.close === 'function' ? adapter.close() : Promise.resolve()
    }
  }
}

module.exports = { createGeocoder: createGeocoder }
