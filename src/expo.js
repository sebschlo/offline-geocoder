"use strict";

const reverse      = require('./reverse')
const forward      = require('./forward')
const findLocation = require('./location').find

// Wraps an expo-sqlite database to match the node-sqlite3 callback
// interface that reverse.js, forward.js and location.js expect.
function wrapExpoDb(expoDb) {
  return {
    all: function(sql, params, callback) {
      expoDb.getAllAsync(sql, params || [])
        .then(function(rows) { callback(null, rows) })
        .catch(function(err) { callback(err) })
    },
    close: function(callback) {
      if (typeof expoDb.closeAsync === 'function') {
        expoDb.closeAsync()
          .then(function() { if (callback) callback(null) })
          .catch(function(err) { if (callback) callback(err) })
      } else if (callback) {
        callback(null)
      }
    }
  }
}

function ExpoGeocoder(options) {
  var opts = options || {}
  var expoDb = opts.db || opts.database

  if (!expoDb || typeof expoDb.getAllAsync !== 'function') {
    throw new Error('Pass an opened expo-sqlite db via { db }.')
  }

  this.db = wrapExpoDb(expoDb)
}

ExpoGeocoder.prototype.reverse = function(latitude, longitude, callback) {
  return reverse(this, latitude, longitude, callback)
}

ExpoGeocoder.prototype.forward = function(query, callback) {
  return forward(this, query, callback)
}

ExpoGeocoder.prototype.location = function() {
  const _this = this

  return {
    find: function(locationId) {
      return findLocation(_this, locationId)
    }
  }
}

function createExpoGeocoder(options) {
  var instance = new ExpoGeocoder(options)

  var locationFn = function() {
    return {
      find: function(locationId) {
        return findLocation(instance, locationId)
      }
    }
  }
  locationFn.find = function(locationId) {
    return findLocation(instance, locationId)
  }
  instance.location = locationFn

  return instance
}

module.exports = createExpoGeocoder;
