# Database compatibility contract

This library ships inside applications together with a pre-built SQLite
database. The two are versioned independently: an app update can pair new
reader code with an old bundled database, and a regenerated database can be
opened by older reader code. **Both directions must keep working.** This
document is the contract that makes that possible.

## The contract

Schema changes must be **additive only**:

- **Never** rename, repurpose, drop, or change the meaning or declared
  type of an existing shipped column or table. Type affinity is
  reader-visible: flipping `latitude REAL` to `TEXT` hands arithmetic a
  string.
- **Never relax** a shipped `NOT NULL` column to nullable — readers may
  rely on a value always being present. Tightening a nullable column to
  `NOT NULL` is reader-safe (`scripts/schema.sql` has already done this to
  `features.name` and `features.country_id` relative to v1.0.0) but
  constrains every builder that writes the table, so treat it as a
  builder-side breaking change.
- New columns must be nullable (or have a default) and may only be added to
  the end of a table with `ALTER TABLE ... ADD COLUMN`.
- New tables are always allowed.

Readers (`src/reverse.js`, `src/forward.js`, `src/location.js`):

- Select and consume columns **by name** — never rely on column order,
  position, or count, so extra columns in a newer database are invisible.
- Feature-detect optional tables and columns at runtime (see
  `getBoundarySchemaStatus` in `src/reverse.js`, which probes
  `sqlite_master`) and degrade gracefully when a generation is absent.
- Must not require any column that older shipped databases lack.

Builders (`scripts/generate_boundary_index.js` and friends):

- When appending to an existing database, upgrade older schemas in place
  with `ALTER TABLE ... ADD COLUMN` (nullable), never by rebuilding or
  rewriting existing tables.
- New columns are builder-side metadata until every shipped reader release
  that might open the database knows about them; readers treat `NULL` as
  the pre-upgrade behavior.

## Known schema generations

Every generation that ever shipped stays supported. A generation may be
cataloged as *pending* while the change introducing it is still in review,
so the reader-side guarantee is pinned ahead of the merge. Newest first:

| # | Generation | Status | Tables | Notes |
|---|---|---|---|---|
| 4 | Compact v2 + population/area | Shipped | `compact_places` (+ nullable `population`, `area`) + `compact_geohash_lookup` | Added by the append/merge work: the extra nullable columns rank append conflicts in the builder, older compact v2 databases are upgraded in place on `--append`, and readers ignore the columns entirely. |
| 3 | Compact v2 | Shipped | `compact_places` + `compact_geohash_lookup` | Seven-column `compact_places` (`id`, `name`, `country_id`, `admin1_id`, `placetype_code`, `latitude`, `longitude`). This is the generation bundled in shipped apps. No stored country display name — the reader uses `country_id` and resolves the admin1 name via a self-join on the region row. |
| 2 | Compact legacy | Shipped | `places` + `place_geohash_lookup` | Full-width `places` table with a flat geohash-to-place lookup; the reader joins `countries`/`admin1` for display names. |
| 1 | Full boundary | Shipped | `places` + `place_geohash_cover` + `place_geometry` | Runtime point-in-polygon over stored geometry. `place_geohash_lookup` exists but may be empty; the reader tries the compact lookup first and falls through to the polygon path. |
| 0 | Centroid-only (v1.0.0) | Shipped | `features` + `coordinates` + `countries` + `admin1` + `everything` view | The originally released schema: four-column `features` (no `asciiname`, no `population`) and no boundary tables. Centroid reverse and id lookup work; forward geocoding feature-detects the missing columns and returns `undefined`; a boundary-mode reader falls through to the centroid path. |

The boundary generations (1–4) may additionally carry the GeoNames base
tables of generation 0 (in their current widened form) for centroid mode,
forward geocoding, and id lookup.

## Enforcement

Every known schema generation has a **permanent fixture** in
[`spec/reader_compatibility_spec.js`](spec/reader_compatibility_spec.js).
Each fixture builds a database with the frozen schema of its generation —
deliberately not derived from `scripts/schema.sql` or the builder, which
move forward over time — and asserts the reader paths that generation
supports (boundary and/or centroid reverse, id lookup, graceful forward
degradation).

A compatibility fixture is only useful if it can fail, so three things are
frozen rather than recomputed:

- **Geohash lookup keys are stored as literals.** Computing them with
  `src/geohash` would make the fixtures self-referential: the reader
  queries with that same encoder, so an incompatible encoder change would
  regenerate the stored keys and the query keys together and stay green
  while real databases became unreadable. A conformance spec pins the
  encoder against published geohash reference vectors and against every
  literal the fixtures store.
- **Each generation's exact schema is asserted** — every column signature
  (`PRAGMA table_info`: name, type, `NOT NULL`, default, primary-key flag)
  *and* the exact set of tables and views. Both halves matter: a fixture
  that gains a table would let a future reader take a query path that
  generation never shipped (boundary readers feature-detect their path),
  while the signatures stop a fixture being quietly widened, retyped or
  relaxed. Column *order* is deliberately not asserted — readers select by
  name.
- **Freshly generated databases are asserted to be supersets** of the
  frozen columns of every generation they have shipped: name and declared
  type must match, and a column frozen as `NOT NULL` or `PRIMARY KEY` must
  remain so, while tightening a historically nullable column is allowed
  because that direction is reader-safe. This covers the contract's
  opposite direction — a builder dropping, renaming, retyping or relaxing
  a column that older readers still need — even while the current reader
  happens to support both layouts. Every generator is exercised:
  `generate_boundary_index.js` in `--index-mode compact` and `--index-mode
  full`, and `scripts/schema.sql` (applied verbatim by
  `generate_geonames.sh`), which is checked against both the centroid and
  the boundary tables it creates, plus the output columns of the
  `everything` view that centroid, forward and id-lookup readers select
  from.

Rules for contributors:

- **Never modify the fixture of a shipped generation.** They pin history;
  a change that requires editing one is a compatibility break by
  definition. A *pending* generation's fixture may still be amended until
  the change introducing it ships.
- When you ship a new schema generation: add a new fixture block to
  `spec/reader_compatibility_spec.js` and a new row to the table above.
- Reader changes must keep every existing fixture green.
