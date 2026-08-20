// The default 5s per-spec/per-hook timeout is tight for this suite on
// shared CI runners: several beforeAll hooks build a complete fixture
// database, which takes well under a second locally but has been observed
// to cross 5s on GitHub Actions (the whole suite runs ~4-5x slower there).
// Raise the ceiling; genuinely hung specs still fail, just later.
jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
