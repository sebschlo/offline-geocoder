'use strict'

var geocoder = require('./core/geocoder')
var expoAdapter = require('./adapters/expo-sqlite')

function createExpoGeocoder(options) {
  var opts = options || {}

  if (opts.adapter) return geocoder.createGeocoder(opts.adapter)

  var db = opts.db || opts.database
  if (!db) {
    throw new Error('Pass an opened expo-sqlite db via { db }.')
  }

  return geocoder.createGeocoder(expoAdapter.createExpoSqliteAdapter(db))
}

module.exports = createExpoGeocoder
module.exports.createExpoGeocoder = createExpoGeocoder
module.exports.createExpoSqliteAdapter = expoAdapter.createExpoSqliteAdapter
module.exports.createGeocoder = geocoder.createGeocoder
