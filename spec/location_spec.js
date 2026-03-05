'use strict'

var createGeocoder = require('../src/index.js')
var fixtureDb = require('./helpers/fixture_db')

describe('geocoder.location', function () {
  var fixture, geocoder

  beforeAll(function () {
    return fixtureDb.createFixtureDatabase().then(function (f) {
      fixture = f
      geocoder = createGeocoder({ database: fixture.databasePath })
    })
  })

  afterAll(function () {
    return geocoder.close().then(function () { fixture.cleanup() })
  })

  describe('.find', function () {
    it('performs a lookup by id', function () {
      return geocoder.location.find(3169070).then(function (result) {
        expect(result).toEqual({
          id: 3169070,
          name: 'Rome',
          formatted: 'Rome, Latium, Italy',
          country: { id: 'IT', name: 'Italy' },
          admin1: { id: 7, name: 'Latium' },
          coordinates: { latitude: 41.89193, longitude: 12.51133 }
        })
      })
    })

    it('accepts geonames: prefixed ids', function () {
      return geocoder.location.find('geonames:3169070').then(function (result) {
        expect(result.id).toEqual(3169070)
      })
    })

    it("resolves undefined when a location can't be found", function () {
      return geocoder.location.find(-1).then(function (result) {
        expect(result).toEqual(undefined)
      })
    })
  })
})
