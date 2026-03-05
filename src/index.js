'use strict'

var path = require('path')
var geocoder = require('./core/geocoder')
var nodeAdapter = require('./adapters/node-sqlite3')

function defaultDatabasePath() {
  return path.join(__dirname, '../data/db.sqlite')
}

function createNodeGeocoder(options) {
  var opts = options || {}

  if (opts.adapter) return geocoder.createGeocoder(opts.adapter)

  var adapter = nodeAdapter.createNodeSqliteAdapter({
    database: opts.database || defaultDatabasePath(),
    db: opts.db,
    sqlite3: opts.sqlite3
  })

  return geocoder.createGeocoder(adapter)
}

module.exports = createNodeGeocoder
module.exports.createNodeGeocoder = createNodeGeocoder
module.exports.createGeocoder = geocoder.createGeocoder
module.exports.createNodeSqliteAdapter = nodeAdapter.createNodeSqliteAdapter
