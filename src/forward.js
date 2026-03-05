"use strict";

const formatLocation = require('./location').format

// Forward geocoding: tries an exact match on name/asciiname first, then
// falls back to prefix and substring matching.
//
// Requires the updated schema with asciiname and population columns.
// Returns undefined on databases without those columns.
function findByName(geocoder, query, callback) {
  return new Promise(function(resolve, reject) {
    var q = typeof query === 'string' ? query.trim() : ''
    if (!q) {
      if (typeof(callback) == 'function') {
        callback(undefined, undefined)
      } else {
        resolve(undefined)
      }
      return
    }

    // Check if the database supports forward search (cached per geocoder)
    if (geocoder._forwardSupported === false) {
      if (typeof(callback) == 'function') {
        callback(undefined, undefined)
      } else {
        resolve(undefined)
      }
      return
    }

    function doSearch() {
      var exactQuery = `SELECT * FROM everything
        WHERE name = ? COLLATE NOCASE OR asciiname = ? COLLATE NOCASE
        ORDER BY
          CASE WHEN name = ? COLLATE NOCASE THEN 0
               WHEN asciiname = ? COLLATE NOCASE THEN 1
               ELSE 2 END,
          population DESC, id ASC
        LIMIT 1`

      geocoder.db.all(exactQuery, [q, q, q, q], function(err, rows) {
        if (err) {
          if (typeof(callback) == 'function') {
            callback(err, undefined)
          } else if (typeof(reject) == 'function') {
            reject(err)
          }
          return
        }

        if (rows && rows[0]) {
          const result = formatLocation(rows[0])
          if (typeof(callback) == 'function') {
            callback(undefined, result)
          } else {
            resolve(result)
          }
          return
        }

        // Fall back to prefix / substring match
        var prefix = q + '%'
        var contains = '%' + q + '%'
        var fuzzyQuery = `SELECT * FROM everything
          WHERE name LIKE ? COLLATE NOCASE
             OR name LIKE ? COLLATE NOCASE
             OR asciiname LIKE ? COLLATE NOCASE
             OR asciiname LIKE ? COLLATE NOCASE
          ORDER BY
            CASE WHEN name LIKE ? COLLATE NOCASE THEN 0
                 WHEN asciiname LIKE ? COLLATE NOCASE THEN 1
                 ELSE 2 END,
            population DESC, LENGTH(name) ASC, id ASC
          LIMIT 1`

        geocoder.db.all(fuzzyQuery, [prefix, contains, prefix, contains, prefix, prefix], function(err, rows) {
          if (err) {
            if (typeof(callback) == 'function') {
              callback(err, undefined)
            } else if (typeof(reject) == 'function') {
              reject(err)
            }
          } else {
            const result = formatResult(rows)
            if (typeof(callback) == 'function') {
              callback(undefined, result)
            } else {
              resolve(result)
            }
          }
        })
      })
    }

    if (geocoder._forwardSupported === true) {
      doSearch()
      return
    }

    // Probe for the asciiname column (first call only)
    geocoder.db.all('SELECT asciiname FROM everything LIMIT 0', [], function(err) {
      geocoder._forwardSupported = !err
      if (err) {
        if (typeof(callback) == 'function') {
          callback(undefined, undefined)
        } else {
          resolve(undefined)
        }
      } else {
        doSearch()
      }
    })
  })
}

function formatResult(rows) {
  const row = rows[0]

  if (row === undefined) {
    return undefined
  } else {
    return formatLocation(row)
  }
}

function Forward(geocoder, query, callback) {
  return findByName(geocoder, query, callback)
}

module.exports = Forward;
