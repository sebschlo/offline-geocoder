# Curation Overlays

This directory holds hand-maintained corrections that are applied *on top of* a
generated compact boundary database. Each file records a small number of
judgment calls that the source data cannot express, together with the reasoning
behind them and probe coordinates that pin down the intended behavior.

## Philosophy: curation is a last resort

The build scripts (`scripts/generate_boundary_index.js`,
`scripts/generate_wof_boundary.sh`) should fix everything that data can fix.
Population thresholds, precision caps, dominant-city rollups, redundant-region
pruning — those are generic rules, and improving them benefits every country at
once. **If a labeling problem can be solved by generalizing a build rule,
solve it there.**

Curation exists for the residue: judgment calls that no generic rule can know.
The canonical example is local naming convention — residents of a corridor
consider themselves part of a city even though the administrative boundaries
say otherwise. That is not derivable from population, area, or hierarchy data;
someone who knows the place has to say so.

Because these entries are opinions, they carry obligations:

- **Every entry must have a `rationale`** explaining the judgment call, in
  enough detail that a reviewer without local knowledge can evaluate it.
- **Every entry must have `probes`** — coordinates with expected labels,
  including *guard* probes that pin down where the curation must **not**
  reach. Validation enforces both probe roles: at least one *positive* probe
  expecting the merge target's label (so the intended relabeling is actually
  exercised) and at least one *guard* probe expecting a different label (so
  the merge's reach is pinned down). Positive probes are checked against the
  target's place id, not just its name, so a same-named place cannot mask an
  incomplete merge.
- Entries should be few. A country file with dozens of entries is a sign the
  build rules need generalizing instead.

Community contributions are welcome: propose changes to these files via pull
request, with the rationale in the entry itself and, ideally, the output of a
`--dry-run` in the PR description.

## File format

Exactly one JSON file per country, named by lowercase ISO 3166-1 alpha-2 code
(`gt.json`, `fr.json`, ...). The filename must match the declared `country`,
and no two loaded files may declare the same country — validation enforces
both — so applying a file by name can only ever change the country it is
named for, and a country's whole overlay always travels in one file.

```json
{
  "country": "GT",
  "entries": [
    {
      "op": "merge",
      "into": 421169087,
      "absorb": [421191461, 1108695621, 421185999],
      "minPrecision": 5,
      "rationale": "Why this judgment call is correct, in reviewable detail.",
      "probes": [
        { "lat": 14.5330, "lon": -90.4350, "expect": "Guatemala City", "note": "km 18 Carretera a El Salvador" },
        { "lat": 14.6339, "lon": -90.6064, "expect": "Mixco", "note": "guard: Mixco stays itself" }
      ]
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `country` | string | Two-letter uppercase ISO country code. Informational; also gates which files you apply to a partial build. |
| `entries` | array | One object per judgment call, applied in order. |
| `entries[].op` | string | Operation. Currently only `"merge"`. |
| `entries[].into` | integer | Place id (Who's On First id) whose label wins. Must exist in `compact_places`. |
| `entries[].absorb` | array of integers | Place ids whose reverse-lookup cells are relabeled to `into`. Must exist in `compact_places`; must not include `into`. |
| `entries[].minPrecision` | integer (1–12) | Only geohash cells of at least this length are relabeled. Coarser cells keep their original owner. |
| `entries[].rationale` | string | Required. The reviewable justification for the entry. |
| `entries[].probes` | array | Required. Coordinates with expected reverse-lookup labels, checked by `--verify`. Must include at least one positive probe (`expect` equals the merge target's name, verified against the target's place id) and at least one guard probe (`expect` differs). |
| `probes[].lat`, `probes[].lon` | number | Probe coordinate. |
| `probes[].expect` | string | Expected `result.name` from a reverse lookup at that coordinate. Must name a place that exists in the entry's country (typo protection). |
| `probes[].note` | string | Optional human context (what the coordinate is, or which guard it enforces). |

Unknown fields are rejected so that typos (`"absorbs"`, `"minPrecison"`) fail
loudly instead of silently doing nothing.

### Semantics of `merge`

For each cell in `compact_geohash_lookup` owned by an absorbed place and whose
geohash length is at least `minPrecision`:

```sql
UPDATE compact_geohash_lookup
SET place_id = <into>
WHERE place_id IN (<absorb...>) AND LENGTH(geohash) >= <minPrecision>
```

- **Fine cells** (length ≥ `minPrecision`) take the `into` label: a user
  standing there sees the city name.
- **Coarse cells** (length < `minPrecision`) keep their original owner: a
  genuinely middle-of-nowhere point that only matches a coarse fallback cell
  keeps reading country-ish instead of claiming a city.
- Absorbed places **stay in `compact_places`** — forward lookups and readers
  holding old ids may still reference them. Only the reverse-lookup cells are
  relabeled.
- The operation is **idempotent by construction**: relabeled cells leave the
  absorbed set, so a second apply changes nothing.
- Applying **reconciles the database to the files as written**, for the
  countries in the run. Any journaled cell whose `(target, source)` pair the
  loaded files no longer declare is returned to its original owner before the
  merges are applied, and cells the current `minPrecision` now defines as
  coarse are returned too. That one rule covers every structural revision:
  raising `minPrecision`, dropping a place from `absorb`, and moving a source
  to a different `into` (its cells sit on the old target, which no entry
  mentions anymore, so they are released first and the new merge picks them
  up). Reconciliation is scoped to the countries being applied, so a Guatemala
  run never disturbs overlays applied earlier for other countries. Cells
  something else has since overwritten are left alone and their journal
  records retired. The one structural change apply cannot see is deleting an
  entire entry — it is indistinguishable from not passing that file: for
  that, run `--revert` and re-apply.
- Application order is **deterministic and irrelevant**: files are applied in
  sorted path order and entries in file order, and cross-entry conflict
  validation (see the conflict policy below) guarantees that every lookup row
  is touched by at most one entry, so the final state never depends on order.
- The apply **journals what it drained** in small bookkeeping tables it
  creates inside the curated database: per-source summary counts in
  `curation_journal`, and every drained cell with its original owner in
  `curation_journal_cells`. Verification uses the per-cell records to
  distinguish a source the data build never had (probes may be deferred) from
  a source a previous apply already consumed (probes stay strict) — scoped to
  the entry's current `minPrecision`, so evidence from an earlier revision at
  a coarser precision does not vouch for a finer one. `--revert` uses the
  same records to restore original ownership (see the refresh workflow
  below).
- The journal is **tied to the current compact-table generation**: an inert
  marker trigger on `compact_geohash_lookup` is dropped by SQLite together
  with the table, so a replace-mode rebuild automatically invalidates the old
  drain evidence and the next apply starts a fresh journal. In-place edits do
  not drop the table, so evidence about the current generation survives them.

## Applying

```bash
# Apply every curation file to a database:
npm run curate -- --database data/geocoder.sqlite --curation curation/

# Apply a single country file:
npm run curate -- --database data/geocoder.sqlite --curation curation/gt.json

# Preview without writing:
npm run curate -- --database data/geocoder.sqlite --curation curation/ --dry-run
```

All files are validated before anything is written: malformed JSON, unknown
fields, ids missing from `compact_places`, and an id appearing as both `into`
and `absorb` all abort with a clear message and a nonzero exit. Validation is
also **global across every loaded file** — conflicting or chained entries are
rejected as a set (see the conflict policy below). The apply runs in a single
transaction.

Note that validation requires every referenced id to exist, so apply only the
files for countries included in your build (a worldwide build can use the whole
directory).

## Refreshing a curated database

- **Replace-mode rebuild** (the generator's default): the compact tables are
  dropped and recreated, which automatically invalidates the journal (see
  above). Simply re-apply curation after the rebuild.
- **Append-mode refresh** (`--append` / `WOF_APPEND=1`): the generator
  removes a place's previous cells by their *current* ownership — which
  curation has rewritten. Appending onto a curated database directly is
  **not supported**: cells relabeled to a merge target could never be cleaned
  up when their absorbed place is re-imported, leaving stale reverse results.
  The supported lifecycle is revert, refresh, re-apply:

  ```bash
  npm run curate -- --database data/geocoder.sqlite --revert
  WOF_APPEND=1 ./scripts/generate_wof_boundary.sh data/geocoder.sqlite
  npm run curate -- --database data/geocoder.sqlite --curation curation/ --verify
  ```

  `--revert` restores every journaled cell that is still owned by its merge
  target back to its original owner and clears the journal; cells something
  else has since overwritten are left alone (and reported).

## Verifying

```bash
npm run curate -- --database data/geocoder.sqlite --curation curation/gt.json --verify
```

`--verify` applies the entries and runs each probe through the library's
boundary reverse lookup **inside the same transaction**, comparing
`result.name` to `expect`. Every `expect` must name a place that exists in
the entry's country — a misspelled label is a validation error before
anything runs, never a deferrable probe. Positive probes (those expecting the
merge target's label) are held to a stricter standard: they must resolve to
the target's **place id** (a same-named place does not count) **from a
matching lookup cell** — a nearest-centroid fallback result never satisfies a
positive probe, because the fallback can return the target for a coordinate
the overlay never reached. In addition, when an entry relabeled any cells,
**at least one passing positive probe must have resolved through one of those
relabeled cells** — the exact lookup row the reverse geocoder matched must be
a cell this entry drained and must still belong to the target. Positive
probes sitting only on cells the target owned all along prove nothing about
the entry's own effect, and a curated fine cell that goes missing cannot be
papered over by a coarser target-owned cell covering the same point. If any
probe fails, the whole
overlay is rolled back and the command exits nonzero with the database
unchanged — a bad entry can never leave a half-curated database behind, and
automation can rely on "nonzero exit means nothing was applied". The reverse
lookup's precision range is derived from the geohash lengths actually present
in the database, so verification works on databases built outside the
library's default range.

`--skip-unresolvable` downgrades a failing probe to a warning only when the
database visibly cannot express that probe's intended result yet:

- the expected place (matched by name within the entry's country) owns no
  lookup cells **with the overlay applied** — if the pending merge itself
  grants the target cells, a failing probe expecting the target exposes an
  incomplete `absorb` set and still fails; or
- the probe expects the merge target's name, the lookup row it matched is
  **not a cell this entry has drained** (per the journal, whoever owns that
  row now), and one of the entry's absorbed places owns no cells the entry
  could actually relabel (at or above its `minPrecision`) **and has no
  journaled drained cells at or above that precision**. In other words: a
  failure is only excused where the entry's data has demonstrably never
  arrived. A failure on a cell the entry drained is a regression and stays
  strict no matter which other source is missing — including when that cell
  has since been handed to a third place; a source whose cells are gone
  because the overlay already consumed them excuses nothing; and evidence
  from an earlier revision at a coarser precision does not vouch for a finer
  one.

Guard probes expecting any other name never inherit deferral from missing
merge sources: a failing guard rolls the transaction back even with the flag.
This lets a curation file ship ahead of the data build that makes it
effective — see below — while on a fully built database mismatches fail even
with the flag.

One failure is never deferred, because no future data can fix it: a positive
probe that lands on a cell **still owned by an absorbed place whose other
cells the entry did relabel**. That can only happen below `minPrecision`, so
the probe is standing on ground the merge deliberately leaves alone and can
never pass — an authoring mistake, not a data gap. `--verify` names the cell,
its precision, and the two ways out (move the probe onto a cell the entry
relabels, or turn it into a guard probe expecting the original owner). When
the source owning that cell has no relabelable cells at all, the same
situation *is* a data gap — the build simply has not reached this precision
here — and stays deferrable.

### A note on the Guatemala probes

Every coordinate in `gt.json` was chosen **empirically against a world build
with county boundaries indexed at precision 5**, not synthesized from a map:
each positive probe sits inside a cell the merge actually drains, and the
whole entry passes strict `--verify` (no `--skip-unresolvable`) on that
build, relabeling 3 cells.

Two things that build taught us, both recorded in the entry's rationale:

- The municipality of Guatemala (421191461) owns **no** cells at precision 5,
  because Guatemala City's locality polygon already covers its municipal
  territory. Absorbing it is a no-op today; it stays in `absorb` as
  future-proofing for builds where the municipality does win cells.
- The corridor cells below roughly km 18 belong to Guatemala City natively or
  to Villa Canales (which keeps its own identity), so the drained territory
  is Santa Catarina Pinula's two cells plus Fraijanes' one. The probes cover
  all three.

On a database built without county boundaries at that precision, the absorbed
municipalities own no cells, the merge is a validated no-op, and
`--verify --skip-unresolvable` defers the probes that cannot resolve yet.

## Contributing and conflict policy

Curation files are community-editable opinions about places, so the rules for
changing them are strict by design:

- **One country per file.** A change to Guatemala lives in `gt.json` and
  nowhere else. This keeps review focused and keeps two contributors from
  editing the same judgment in different places. Validation enforces it:
  every `into` and `absorb` id must belong to the file's declared country, so
  a typo'd id that happens to identify a real place elsewhere in the world is
  rejected instead of silently relabeling a foreign place.
- **Every entry carries a `rationale` and `probes`.** Entries without them are
  rejected by validation, not just by review.
- **Existing probes are permanent regression guards.** Once an entry's probes
  are merged, they document settled behavior — including the guard probes that
  pin down where a curation must *not* reach. A new entry that flips an
  established probe fails `--verify` and will not be accepted; if you believe
  a settled probe is wrong, change the probe in the same PR and argue the case
  in the entry's rationale.
- **Conflicting entries are rejected as a set**, before anything is written,
  across all loaded files:
  - the same place id absorbed by two entries with **different `into`
    targets** (the two entries disagree about where the place belongs);
  - a place id that is any entry's `into` being absorbed by another entry
    (**merge chains** — `A -> B` plus `C -> A` would make the result depend on
    application order and break idempotence);
  - the same place id absorbed by two entries with the **same target**
    (duplicate absorption). This is mechanically harmless but is rejected as
    an error anyway: duplicated judgment drifts when someone later edits one
    copy and not the other. Keep one entry per absorbed place.
- **Curation never alters the library's tables.** Schema-level backwards
  compatibility is governed by the repository's compatibility contract,
  `COMPATIBILITY.md` (introduced by
  [#4](https://github.com/sebschlo/offline-geocoder/pull/4)); curation only
  relabels `compact_geohash_lookup` rows within whatever schema the database
  already has, plus its own `curation_journal` bookkeeping table, which no
  reader queries. Absorbed places intentionally remain in `compact_places`,
  so place ids stored by old readers and forward lookups keep resolving.
- **The maintainer arbitrates judgment disputes.** When two contributors
  disagree about what a place should be called, probes and rationales are the
  evidence, and the maintainer makes the call.

## Current entries

- **`gt.json` — Guatemala.** In Guatemala City's metro, the Carretera a El
  Salvador corridor (the municipalities Santa Catarina Pinula and Fraijanes)
  functions as part of the city, and the municipality of Guatemala carries the
  bare name "Guatemala", which renders like a country-only label in apps. All
  three are absorbed into the Guatemala City label at precision ≥ 5, while
  coarse fallback cells keep their original owners. Mixco and Villa Nueva
  intentionally keep their own identities, and Villa Canales — which owns the
  corridor cells nearer the city — keeps its own name too. Verified strictly
  against a world build; see the note on the Guatemala probes above.
