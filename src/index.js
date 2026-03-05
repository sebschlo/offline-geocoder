"use strict";

const path         = require('path')
const reverse      = require('./reverse')
const forward      = require('./forward')
const findLocation = require('./location').find

function Geocoder(options) {
  var geocoder = function(options) {
    this.options = options || {}

    if (this.options.db) {
      // Accept a pre-opened database object (must have .all(sql, params, cb))
      this.db = this.options.db
    } else {
      var sqlite3
      try {
        sqlite3 = (this.options.sqlite3 || require('sqlite3')).verbose()
      } catch (err) {
        err.message = 'sqlite3 is required for Node usage. Install it with `npm install sqlite3`.'
        throw err
      }

      if (this.options.database === undefined) {
        this.options.database = path.join(__dirname, '../data/db.sqlite')
      }

      this.db = new sqlite3.Database(this.options.database)
    }
  }

  geocoder.prototype.reverse = function(latitude, longitude, callback) {
    return reverse(this, latitude, longitude, callback)
  }

  geocoder.prototype.forward = function(query, callback) {
    return forward(this, query, callback)
  }

  geocoder.prototype.location = function() {
    const _this = this

    return {
      find: function(locationId) {
        return findLocation(_this, locationId)
      }
    }
  }

  var instance = new geocoder(options)

  // Also support geocoder.location.find(id) without calling location()
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

module.exports = Geocoder;
