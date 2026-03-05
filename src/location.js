"use strict";

function normalizeId(value) {
  if (typeof value === 'string') {
    var match = /^geonames:(\d+)$/i.exec(value.trim())
    if (match) return Number(match[1])
    return Number(value)
  }
  return value
}

function find(geocoder, locationId) {
  return new Promise(function(resolve, reject) {
    const query = `SELECT * FROM everything WHERE id = ? LIMIT 1`

    geocoder.db.all(query, [normalizeId(locationId)], function(err, rows) {
      if (err) {
        reject(err)
      } else {
        resolve(formatResult(rows))
      }
    })
  })
}

function formatResult(rows) {
  const row = rows[0]

  if (row === undefined) {
    return undefined
  } else {
    return format(row)
  }
}

function format(result) {
  // Construct the formatted name consisting of the name, admin1 name and
  // country name. Some features don't have an admin1, and others may have the
  // same name as the feature, so this handles that.
  let nameParts = []
  nameParts.push(result.name)
  if (result.admin1_name && result.admin1_name != result.name) {
    nameParts.push(result.admin1_name)
  }
  nameParts.push(result.country_name)
  const formattedName = nameParts.join(', ')

  return {
    id:        result.id,
    name:      result.name,
    formatted: formattedName,
    country: {
      id:   result.country_id,
      name: result.country_name
    },
    admin1: {
      id:   result.admin1_id,
      name: result.admin1_name,
    },
    coordinates: {
      latitude:  result.latitude,
      longitude: result.longitude
    }
  }
}

module.exports = {
  find:   find,
  format: format
}
