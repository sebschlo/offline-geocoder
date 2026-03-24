const geometry = require('../src/geometry');

describe('geometry utilities', () => {
  it('handles polygon holes in point-in-polygon checks', () => {
    const polygonWithHole = {
      type: 'Polygon',
      coordinates: [
        [[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]],
        [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
      ]
    };

    expect(geometry.pointInGeometry(polygonWithHole, 2, 2)).toBeTrue();
    expect(geometry.pointInGeometry(polygonWithHole, 0, 0)).toBeFalse();
  });

  it('supports multipolygon containment', () => {
    const multipolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-11, -11], [-9, -11], [-9, -9], [-11, -9], [-11, -11]]],
        [[[9, 9], [11, 9], [11, 11], [9, 11], [9, 9]]]
      ]
    };

    expect(geometry.pointInGeometry(multipolygon, 10, 10)).toBeTrue();
    expect(geometry.pointInGeometry(multipolygon, 0, 0)).toBeFalse();
  });

  it('detects when one geometry is contained by another', () => {
    const outer = {
      type: 'Polygon',
      coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
    };
    const inner = {
      type: 'Polygon',
      coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]
    };
    const farAway = {
      type: 'Polygon',
      coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]
    };

    expect(geometry.geometryContainsGeometry(outer, inner)).toBeTrue();
    expect(geometry.geometryContainsGeometry(outer, farAway)).toBeFalse();
  });
});
