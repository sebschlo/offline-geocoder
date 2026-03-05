'use strict'

var sqlite3 = require('sqlite3')
var fixtureDb = require('./helpers/fixture_db')

function all(db, sql) {
  return new Promise(function (resolve, reject) {
    db.all(sql, [], function (err, rows) {
      err ? reject(err) : resolve(rows || [])
    })
  })
}

function close(db) {
  return new Promise(function (resolve, reject) {
    db.close(function (err) { err ? reject(err) : resolve() })
  })
}

describe('generated schema', function () {
  var fixture, db

  beforeAll(function () {
    return fixtureDb.createFixtureDatabase().then(function (f) {
      fixture = f
      db = new sqlite3.Database(fixture.databasePath)
    })
  })

  afterAll(function () {
    return close(db).then(function () { fixture.cleanup() })
  })

  it('has asciiname and population in the everything view', function () {
    return all(db, 'PRAGMA table_info(everything)').then(function (cols) {
      var names = cols.map(function (c) { return c.name })
      expect(names).toContain('asciiname')
      expect(names).toContain('population')
    })
  })

  it('creates indexes for reverse and forward lookups', function () {
    return Promise.all([
      all(db, "PRAGMA index_list('coordinates')"),
      all(db, "PRAGMA index_list('features')")
    ]).then(function (results) {
      var coordNames = results[0].map(function (i) { return i.name })
      var featNames = results[1].map(function (i) { return i.name })

      expect(coordNames).toContain('coordinates_lat_lng')
      expect(featNames).toContain('features_name_nocase')
      expect(featNames).toContain('features_asciiname_nocase')
      expect(featNames).toContain('features_population_desc')
    })
  })
})
