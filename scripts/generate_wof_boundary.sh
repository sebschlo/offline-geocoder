#!/bin/bash
set -euo pipefail

# Build boundary-aware lookup tables from Who's On First admin repositories.
#
# Usage:
#   ./scripts/generate_wof_boundary.sh [output_db_path]
#
# Environment variables:
#   WOF_COUNTRIES                  Comma-separated ISO2 country codes (default: FR,IT)
#   WOF_WORKDIR                    Working directory for archives/extraction (default: ./tmp/wof-build)
#   WOF_DOWNLOAD                   Set to 0 to skip downloads and reuse existing archives (default: 1)
#   WOF_REF                        Git ref to download from codeload (default: master)
#   WOF_REF_LOCK_FILE              Optional file with per-country pinned refs: "<iso2> <ref>" per line
#   WOF_BASE_PRECISION             Geohash base precision (default: 4)
#   WOF_MAX_PRECISION              Geohash max precision (default: 5)
#   WOF_LOCALITY_MAX_PRECISION     Locality max precision override (default: WOF_MAX_PRECISION)
#   WOF_LOCALADMIN_MAX_PRECISION   Localadmin max precision override (default: WOF_MAX_PRECISION)
#   WOF_COUNTY_MAX_PRECISION       County max precision override. When unset, the node script
#                                  picks the default: WOF_MAX_PRECISION, or one below the dense
#                                  precision (clamped to WOF_MAX_PRECISION) when the dense
#                                  county rule is enabled
#   WOF_COUNTY_DENSE_MAX_PRECISION Dense small-county precision (default: empty = rule off)
#   WOF_COUNTY_DENSE_MAX_AREA_KM2  Bbox area threshold to apply dense county precision (default: empty = rule off)
#   WOF_REGION_MAX_PRECISION       Region max precision override (default: 4)
#   WOF_REGION_SPARSE_MAX_PRECISION  Sparse large-region precision (default: 3)
#   WOF_REGION_SPARSE_MIN_AREA_KM2 Area threshold for sparse region precision (default: 80000)
#   WOF_PROMOTE_LOCALITY_OVER_REGION Prefer locality labels over region in shared parent cells (default: 1)
#   WOF_DOMINANT_LOCALITY_POPULATION Major-locality threshold for dominant-city rollup (default: 100000)
#   WOF_DOMINANT_LOCALITY_RATIO      Dominant-vs-next locality population ratio (default: 3)
#   WOF_PARENT_LOCALITY_MIN_SHARE    Minimum child-cell share (0..1) required for locality parent takeover (default: 0.5)
#   WOF_INCLUDE_LOCALADMIN         Include localadmin placetypes (default: 0)
#   WOF_INCLUDE_COUNTY             Include county placetypes (default: 1)
#   WOF_INCLUDE_REGION             Include region placetypes (default: 1)
#   WOF_DROP_CONTAINED_LOCALITIES  Drop localities contained in larger localities (default: 1)
#   WOF_INCLUDE_ALT                Include -alt- geometries (default: 0)
#   WOF_GEOMETRY_DECIMALS          Optional coordinate rounding precision (e.g. 4)
#   WOF_MIN_POPULATION             Optional minimum population filter (default: 0)
#   WOF_ISOLATION_MIN_POPULATION   Lower population floor for isolated localities (default: 500)
#   WOF_ENSURE_COUNTRY_LOCALITY    Guarantee at least one locality per country (default: 1)
#   WOF_MAX_PLACES                 Optional cap for experiment runs
#   WOF_SKIP_INVALID_REPOS         Skip repos missing expected extracted data dir (default: 1)
#   WOF_BATCH_SIZE                 Countries per node invocation to limit memory (default: 10)
#   WOF_APPEND                     Append to existing DB instead of replacing schema (default: 0)
#
# Notes:
#   - This helper always builds `--index-mode compact` (geohash -> place only).

WOF_COUNTRIES="${WOF_COUNTRIES:-FR,IT}"
WOF_WORKDIR="${WOF_WORKDIR:-$(pwd)/tmp/wof-build}"
WOF_DOWNLOAD="${WOF_DOWNLOAD:-1}"
WOF_REF="${WOF_REF:-master}"
WOF_REF_LOCK_FILE="${WOF_REF_LOCK_FILE:-}"
WOF_BASE_PRECISION="${WOF_BASE_PRECISION:-4}"
WOF_MAX_PRECISION="${WOF_MAX_PRECISION:-5}"
WOF_LOCALITY_MAX_PRECISION="${WOF_LOCALITY_MAX_PRECISION:-${WOF_MAX_PRECISION}}"
WOF_LOCALADMIN_MAX_PRECISION="${WOF_LOCALADMIN_MAX_PRECISION:-${WOF_MAX_PRECISION}}"
# WOF_COUNTY_MAX_PRECISION deliberately has no shell-side default: when it is
# unset the flag is omitted and the node script derives the county cap (the
# global max precision, or one below the clamped dense precision when the
# dense county rule is enabled), so both entry points behave identically.
WOF_COUNTY_MAX_PRECISION="${WOF_COUNTY_MAX_PRECISION:-}"
WOF_COUNTY_DENSE_MAX_PRECISION="${WOF_COUNTY_DENSE_MAX_PRECISION:-}"
WOF_COUNTY_DENSE_MAX_AREA_KM2="${WOF_COUNTY_DENSE_MAX_AREA_KM2:-}"
WOF_REGION_MAX_PRECISION="${WOF_REGION_MAX_PRECISION:-4}"
WOF_REGION_SPARSE_MAX_PRECISION="${WOF_REGION_SPARSE_MAX_PRECISION:-3}"
WOF_REGION_SPARSE_MIN_AREA_KM2="${WOF_REGION_SPARSE_MIN_AREA_KM2:-80000}"
WOF_PROMOTE_LOCALITY_OVER_REGION="${WOF_PROMOTE_LOCALITY_OVER_REGION:-1}"
WOF_DOMINANT_LOCALITY_POPULATION="${WOF_DOMINANT_LOCALITY_POPULATION:-100000}"
WOF_DOMINANT_LOCALITY_RATIO="${WOF_DOMINANT_LOCALITY_RATIO:-3}"
WOF_PARENT_LOCALITY_MIN_SHARE="${WOF_PARENT_LOCALITY_MIN_SHARE:-0.5}"
WOF_INCLUDE_LOCALADMIN="${WOF_INCLUDE_LOCALADMIN:-0}"
WOF_INCLUDE_COUNTY="${WOF_INCLUDE_COUNTY:-1}"
WOF_INCLUDE_REGION="${WOF_INCLUDE_REGION:-1}"
WOF_DROP_CONTAINED_LOCALITIES="${WOF_DROP_CONTAINED_LOCALITIES:-1}"
WOF_INCLUDE_ALT="${WOF_INCLUDE_ALT:-0}"
WOF_GEOMETRY_DECIMALS="${WOF_GEOMETRY_DECIMALS:-}"
WOF_MIN_POPULATION="${WOF_MIN_POPULATION:-0}"
WOF_ISOLATION_MIN_POPULATION="${WOF_ISOLATION_MIN_POPULATION:-500}"
WOF_ENSURE_COUNTRY_LOCALITY="${WOF_ENSURE_COUNTRY_LOCALITY:-1}"
WOF_MAX_PLACES="${WOF_MAX_PLACES:-}"
WOF_SKIP_INVALID_REPOS="${WOF_SKIP_INVALID_REPOS:-1}"
WOF_APPEND="${WOF_APPEND:-0}"
OUTPUT="${1:-db.sqlite}"

case "${OUTPUT}" in
  /*) ;;
  *) OUTPUT="$(pwd)/${OUTPUT}" ;;
esac

if [[ -n "${WOF_REF_LOCK_FILE}" ]]; then
  case "${WOF_REF_LOCK_FILE}" in
    /*) ;;
    *) WOF_REF_LOCK_FILE="$(pwd)/${WOF_REF_LOCK_FILE}" ;;
  esac

  if [[ ! -f "${WOF_REF_LOCK_FILE}" ]]; then
    echo "WOF_REF_LOCK_FILE does not exist: ${WOF_REF_LOCK_FILE}" >&2
    exit 1
  fi
fi

resolve_country_ref() {
  local country="$1"
  local fallback_ref="$2"

  if [[ -z "${WOF_REF_LOCK_FILE}" ]]; then
    echo "${fallback_ref}"
    return 0
  fi

  local resolved_ref
  resolved_ref="$(awk -F'[,\t ]+' -v cc="${country}" '
    BEGIN { lower = tolower(cc) }
    /^[[:space:]]*#/ { next }
    NF < 2 { next }
    {
      if (tolower($1) == lower) {
        print $2
        exit
      }
    }
  ' "${WOF_REF_LOCK_FILE}")"

  if [[ -z "${resolved_ref}" ]]; then
    echo "Missing pinned ref for country ${country} in ${WOF_REF_LOCK_FILE}" >&2
    exit 1
  fi

  echo "${resolved_ref}"
}

ARCHIVE_DIR="${WOF_WORKDIR}/archives"
EXTRACT_DIR="${WOF_WORKDIR}/extracted"
mkdir -p "${ARCHIVE_DIR}" "${EXTRACT_DIR}"

# Build the common flags array shared by every invocation.
COMMON_FLAGS=(
  --index-mode "compact"
  --base-precision "${WOF_BASE_PRECISION}"
  --max-precision "${WOF_MAX_PRECISION}"
  --locality-max-precision "${WOF_LOCALITY_MAX_PRECISION}"
  --localadmin-max-precision "${WOF_LOCALADMIN_MAX_PRECISION}"
  --region-max-precision "${WOF_REGION_MAX_PRECISION}"
  --region-sparse-max-precision "${WOF_REGION_SPARSE_MAX_PRECISION}"
  --region-sparse-min-area-km2 "${WOF_REGION_SPARSE_MIN_AREA_KM2}"
  --promote-locality-over-region "${WOF_PROMOTE_LOCALITY_OVER_REGION}"
  --dominant-locality-population "${WOF_DOMINANT_LOCALITY_POPULATION}"
  --dominant-locality-ratio "${WOF_DOMINANT_LOCALITY_RATIO}"
  --parent-locality-min-share "${WOF_PARENT_LOCALITY_MIN_SHARE}"
  --include-localadmin "${WOF_INCLUDE_LOCALADMIN}"
  --include-county "${WOF_INCLUDE_COUNTY}"
  --include-region "${WOF_INCLUDE_REGION}"
  --drop-contained-localities "${WOF_DROP_CONTAINED_LOCALITIES}"
  --include-alt "${WOF_INCLUDE_ALT}"
  --min-population "${WOF_MIN_POPULATION}"
  --isolation-min-population "${WOF_ISOLATION_MIN_POPULATION}"
  --ensure-country-locality "${WOF_ENSURE_COUNTRY_LOCALITY}"
)

if [[ -n "${WOF_COUNTY_MAX_PRECISION}" ]]; then
  COMMON_FLAGS+=(--county-max-precision "${WOF_COUNTY_MAX_PRECISION}")
fi

if [[ -n "${WOF_COUNTY_DENSE_MAX_PRECISION}" ]]; then
  COMMON_FLAGS+=(--county-dense-max-precision "${WOF_COUNTY_DENSE_MAX_PRECISION}")
fi

if [[ -n "${WOF_COUNTY_DENSE_MAX_AREA_KM2}" ]]; then
  COMMON_FLAGS+=(--county-dense-max-area-km2 "${WOF_COUNTY_DENSE_MAX_AREA_KM2}")
fi

if [[ -n "${WOF_MAX_PLACES}" ]]; then
  COMMON_FLAGS+=(--max-places "${WOF_MAX_PLACES}")
fi

if [[ -n "${WOF_GEOMETRY_DECIMALS}" ]]; then
  COMMON_FLAGS+=(--geometry-decimals "${WOF_GEOMETRY_DECIMALS}")
fi

WOF_BATCH_SIZE="${WOF_BATCH_SIZE:-10}"

# Phase 1: Download all archives (small on disk, skip extraction).
# Collect country codes and their archive paths for batched processing.
COUNTRY_CODES=()
COUNTRY_ARCHIVES=()

IFS=',' read -r -a COUNTRY_ITEMS <<< "${WOF_COUNTRIES}"
for item in "${COUNTRY_ITEMS[@]}"; do
  country="$(echo "${item}" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ -z "${country}" ]]; then
    continue
  fi

  repo="whosonfirst-data-admin-${country}"
  country_ref="$(resolve_country_ref "${country}" "${WOF_REF}")"
  archive="${ARCHIVE_DIR}/${repo}-${country_ref}.tar.gz"

  if [[ ! -f "${archive}" ]]; then
    if [[ "${WOF_DOWNLOAD}" != "1" ]]; then
      echo "Missing ${archive} and WOF_DOWNLOAD=${WOF_DOWNLOAD}." >&2
      echo "Provide the archive locally or set WOF_DOWNLOAD=1." >&2
      exit 1
    fi

    url="https://codeload.github.com/whosonfirst-data/${repo}/tar.gz/${country_ref}"
    echo "Downloading ${repo}@${country_ref}..."
    curl --fail --silent --show-error --location \
      --retry 5 --retry-delay 2 --retry-connrefused \
      "${url}" -o "${archive}"
  else
    echo "Using existing archive ${archive}"
  fi

  COUNTRY_CODES+=("${country}")
  COUNTRY_ARCHIVES+=("${archive}")
done

if [[ ${#COUNTRY_CODES[@]} -eq 0 ]]; then
  echo "No countries resolved from WOF_COUNTRIES=${WOF_COUNTRIES}" >&2
  exit 1
fi

# Phase 2: Extract, process, and clean up in batches to limit disk usage.
# Each batch extracts its countries, runs the node script, then removes
# the extracted data before the next batch starts.

# Helper: extract a single country archive, print its data dir path.
# Returns 1 if the country should be skipped.
extract_country() {
  local country="$1"
  local archive="$2"

  local country_extract="${EXTRACT_DIR}/${country}"
  rm -rf "${country_extract}"
  mkdir -p "${country_extract}"
  if ! tar -xzf "${archive}" -C "${country_extract}"; then
    if [[ "${WOF_SKIP_INVALID_REPOS}" == "1" ]]; then
      echo "Warning: failed to extract ${archive}; skipping" >&2
      return 1
    fi
    echo "Failed to extract ${archive}" >&2
    exit 1
  fi

  local root_dir
  root_dir="$(find "${country_extract}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${root_dir}" ]]; then
    if [[ "${WOF_SKIP_INVALID_REPOS}" == "1" ]]; then
      echo "Warning: no extracted root directory for ${country}; skipping" >&2
      return 1
    fi
    echo "Failed to find extracted root directory for ${country}" >&2
    exit 1
  fi

  local data_dir="${root_dir}/data"
  if [[ ! -d "${data_dir}" ]]; then
    if [[ "${WOF_SKIP_INVALID_REPOS}" == "1" ]]; then
      echo "Warning: expected data directory not found for ${country}; skipping (${data_dir})" >&2
      return 1
    fi
    echo "Expected data directory not found: ${data_dir}" >&2
    exit 1
  fi

  echo "${data_dir}"
}

TOTAL="${#COUNTRY_CODES[@]}"
IS_FIRST=1
BATCH_IDX=0

while [[ "${BATCH_IDX}" -lt "${TOTAL}" ]]; do
  BATCH_END=$(( BATCH_IDX + WOF_BATCH_SIZE ))
  if [[ "${BATCH_END}" -gt "${TOTAL}" ]]; then
    BATCH_END="${TOTAL}"
  fi

  BATCH_COUNTRIES=("${COUNTRY_CODES[@]:${BATCH_IDX}:${WOF_BATCH_SIZE}}")
  BATCH_ARCHIVES=("${COUNTRY_ARCHIVES[@]:${BATCH_IDX}:${WOF_BATCH_SIZE}}")

  echo "--- Batch $(( BATCH_IDX / WOF_BATCH_SIZE + 1 )): ${#BATCH_COUNTRIES[@]} countries (${BATCH_COUNTRIES[*]}) ---"

  # Extract this batch's countries.
  INPUT_ARGS=()
  EXTRACTED_DIRS=()
  for (( i=0; i < ${#BATCH_COUNTRIES[@]}; i++ )); do
    data_dir="$(extract_country "${BATCH_COUNTRIES[$i]}" "${BATCH_ARCHIVES[$i]}")" || continue
    INPUT_ARGS+=(--input-dir "${data_dir}")
    EXTRACTED_DIRS+=("${EXTRACT_DIR}/${BATCH_COUNTRIES[$i]}")
  done

  if [[ ${#INPUT_ARGS[@]} -gt 0 ]]; then
    CMD=(
      node "$(pwd)/scripts/generate_boundary_index.js"
      --database "${OUTPUT}"
      "${COMMON_FLAGS[@]}"
    )
    if [[ "${IS_FIRST}" == "1" ]] && [[ "${WOF_APPEND}" != "1" ]]; then
      IS_FIRST=0
    else
      CMD+=(--append)
    fi
    CMD+=("${INPUT_ARGS[@]}")
    "${CMD[@]}"
  fi

  # Clean up extracted data for this batch to free disk space.
  for dir in "${EXTRACTED_DIRS[@]}"; do
    rm -rf "${dir}"
  done

  BATCH_IDX="${BATCH_END}"
done
