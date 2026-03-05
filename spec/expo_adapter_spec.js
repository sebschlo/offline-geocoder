'use strict'

var createExpoGeocoder = require('../src/expo.js')
var fixtureDb = require('./helpers/fixture_db')

describe('expo adapter', function () {
  var fixture

  beforeAll(function () {
    return fixtureDb.createFixtureDatabase().then(function (f) {
      fixture = f
    })
  })

  afterAll(function () { fixture.cleanup() })

  it('runs queries through the getAllAsync shim', function () {
    var db = fixtureDb.createExpoDb(fixture.databasePath)
    var geocoder = createExpoGeocoder({ db: db })

    return geocoder.reverse(41.89, 12.49).then(function (result) {
      expect(result.id).toEqual(3169070)
      return geocoder.close()
    })
  })
})
