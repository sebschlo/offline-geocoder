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
#   WOF_BASE_PRECISION             Geohash base precision (default: 4)
#   WOF_MAX_PRECISION              Geohash max precision (default: 5)
#   WOF_LOCALITY_MAX_PRECISION     Locality max precision override (default: WOF_MAX_PRECISION)
#   WOF_LOCALADMIN_MAX_PRECISION   Localadmin max precision override (default: WOF_MAX_PRECISION)
#   WOF_REGION_MAX_PRECISION       Region max precision override (default: 4)
#   WOF_REGION_SPARSE_MAX_PRECISION  Sparse large-region precision (default: 3)
#   WOF_REGION_SPARSE_MIN_AREA_KM2 Area threshold for sparse region precision (default: 80000)
#   WOF_PROMOTE_LOCALITY_OVER_REGION Prefer locality labels over region in shared parent cells (default: 1)
#   WOF_INCLUDE_LOCALADMIN         Include localadmin placetypes (default: 0)
#   WOF_INCLUDE_REGION             Include region placetypes (default: 1)
#   WOF_DROP_CONTAINED_LOCALITIES  Drop localities contained in larger localities (default: 1)
#   WOF_INCLUDE_ALT                Include -alt- geometries (default: 0)
#   WOF_GEOMETRY_DECIMALS          Optional coordinate rounding precision (e.g. 4)
#   WOF_MIN_POPULATION             Optional minimum population filter (default: 0)
#   WOF_MAX_PLACES                 Optional cap for experiment runs
#
# Notes:
#   - This helper always builds `--index-mode compact` (geohash -> place only).

WOF_COUNTRIES="${WOF_COUNTRIES:-FR,IT}"
WOF_WORKDIR="${WOF_WORKDIR:-$(pwd)/tmp/wof-build}"
WOF_DOWNLOAD="${WOF_DOWNLOAD:-1}"
WOF_REF="${WOF_REF:-master}"
WOF_BASE_PRECISION="${WOF_BASE_PRECISION:-4}"
WOF_MAX_PRECISION="${WOF_MAX_PRECISION:-5}"
WOF_LOCALITY_MAX_PRECISION="${WOF_LOCALITY_MAX_PRECISION:-${WOF_MAX_PRECISION}}"
WOF_LOCALADMIN_MAX_PRECISION="${WOF_LOCALADMIN_MAX_PRECISION:-${WOF_MAX_PRECISION}}"
WOF_REGION_MAX_PRECISION="${WOF_REGION_MAX_PRECISION:-4}"
WOF_REGION_SPARSE_MAX_PRECISION="${WOF_REGION_SPARSE_MAX_PRECISION:-3}"
WOF_REGION_SPARSE_MIN_AREA_KM2="${WOF_REGION_SPARSE_MIN_AREA_KM2:-80000}"
WOF_PROMOTE_LOCALITY_OVER_REGION="${WOF_PROMOTE_LOCALITY_OVER_REGION:-1}"
WOF_INCLUDE_LOCALADMIN="${WOF_INCLUDE_LOCALADMIN:-0}"
WOF_INCLUDE_REGION="${WOF_INCLUDE_REGION:-1}"
WOF_DROP_CONTAINED_LOCALITIES="${WOF_DROP_CONTAINED_LOCALITIES:-1}"
WOF_INCLUDE_ALT="${WOF_INCLUDE_ALT:-0}"
WOF_GEOMETRY_DECIMALS="${WOF_GEOMETRY_DECIMALS:-}"
WOF_MIN_POPULATION="${WOF_MIN_POPULATION:-0}"
WOF_MAX_PLACES="${WOF_MAX_PLACES:-}"
OUTPUT="${1:-db.sqlite}"

case "${OUTPUT}" in
  /*) ;;
  *) OUTPUT="$(pwd)/${OUTPUT}" ;;
esac

ARCHIVE_DIR="${WOF_WORKDIR}/archives"
EXTRACT_DIR="${WOF_WORKDIR}/extracted"
mkdir -p "${ARCHIVE_DIR}" "${EXTRACT_DIR}"

INPUT_ARGS=()

IFS=',' read -r -a COUNTRY_ITEMS <<< "${WOF_COUNTRIES}"
for item in "${COUNTRY_ITEMS[@]}"; do
  country="$(echo "${item}" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ -z "${country}" ]]; then
    continue
  fi

  repo="whosonfirst-data-admin-${country}"
  archive="${ARCHIVE_DIR}/${repo}-${WOF_REF}.tar.gz"

  if [[ ! -f "${archive}" ]]; then
    if [[ "${WOF_DOWNLOAD}" != "1" ]]; then
      echo "Missing ${archive} and WOF_DOWNLOAD=${WOF_DOWNLOAD}." >&2
      echo "Provide the archive locally or set WOF_DOWNLOAD=1." >&2
      exit 1
    fi

    url="https://codeload.github.com/whosonfirst-data/${repo}/tar.gz/${WOF_REF}"
    echo "Downloading ${repo}@${WOF_REF}..."
    curl -fsSL "${url}" -o "${archive}"
  else
    echo "Using existing archive ${archive}"
  fi

  country_extract="${EXTRACT_DIR}/${country}"
  rm -rf "${country_extract}"
  mkdir -p "${country_extract}"
  tar -xzf "${archive}" -C "${country_extract}"

  root_dir="$(find "${country_extract}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${root_dir}" ]]; then
    echo "Failed to find extracted root directory for ${repo}" >&2
    exit 1
  fi

  data_dir="${root_dir}/data"
  if [[ ! -d "${data_dir}" ]]; then
    echo "Expected data directory not found: ${data_dir}" >&2
    exit 1
  fi

  INPUT_ARGS+=(--input-dir "${data_dir}")
done

if [[ ${#INPUT_ARGS[@]} -eq 0 ]]; then
  echo "No input directories resolved from WOF_COUNTRIES=${WOF_COUNTRIES}" >&2
  exit 1
fi

CMD=(
  node "$(pwd)/scripts/generate_boundary_index.js"
  --database "${OUTPUT}"
  --index-mode "compact"
  --base-precision "${WOF_BASE_PRECISION}"
  --max-precision "${WOF_MAX_PRECISION}"
  --locality-max-precision "${WOF_LOCALITY_MAX_PRECISION}"
  --localadmin-max-precision "${WOF_LOCALADMIN_MAX_PRECISION}"
  --region-max-precision "${WOF_REGION_MAX_PRECISION}"
  --region-sparse-max-precision "${WOF_REGION_SPARSE_MAX_PRECISION}"
  --region-sparse-min-area-km2 "${WOF_REGION_SPARSE_MIN_AREA_KM2}"
  --promote-locality-over-region "${WOF_PROMOTE_LOCALITY_OVER_REGION}"
  --include-localadmin "${WOF_INCLUDE_LOCALADMIN}"
  --include-region "${WOF_INCLUDE_REGION}"
  --drop-contained-localities "${WOF_DROP_CONTAINED_LOCALITIES}"
  --include-alt "${WOF_INCLUDE_ALT}"
  --min-population "${WOF_MIN_POPULATION}"
)

if [[ -n "${WOF_MAX_PLACES}" ]]; then
  CMD+=(--max-places "${WOF_MAX_PLACES}")
fi

if [[ -n "${WOF_GEOMETRY_DECIMALS}" ]]; then
  CMD+=(--geometry-decimals "${WOF_GEOMETRY_DECIMALS}")
fi

CMD+=("${INPUT_ARGS[@]}")

"${CMD[@]}"
