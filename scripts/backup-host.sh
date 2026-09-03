#!/usr/bin/env bash
# Host-side backup for a deployed PacketChat stack.
#
# scripts/backup.mjs needs Node and the repo's dependencies; a deployment host
# has neither (the deploy ships source, not node_modules). This does the same
# two dumps with nothing but docker and coreutils, so it can run from a systemd
# timer on the box itself.
#
#   ./scripts/backup-host.sh [--dir /opt/stacks/packetchat] [--keep 14]
set -euo pipefail

STACK_DIR="${PACKETCHAT_DIR:-/opt/stacks/packetchat}"
KEEP="${PACKETCHAT_BACKUP_KEEP:-14}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) STACK_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

COMPOSE_FILE="${STACK_DIR}/infrastructure/compose/docker-compose.yml"
ENV_FILE="${STACK_DIR}/.env"
BACKUP_DIR="${STACK_DIR}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '%s backup: %s\n' "$(date -Is)" "$*"; }
die() { printf '%s backup: ERROR %s\n' "$(date -Is)" "$*" >&2; exit 1; }

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found at $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found at $ENV_FILE"
mkdir -p "$BACKUP_DIR"

dc() { sudo -n docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# POSTGRES_USER/DB are compose interpolation defaults rather than .env entries,
# so read an override if one exists and fall back to the same default compose
# uses. .env is parsed, not sourced: it may carry CRLF endings and sourcing an
# env file executes it.
read_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true)"
  printf '%s' "${value:-$fallback}"
}

PG_USER="$(read_env POSTGRES_USER packetchat)"
PG_DB="$(read_env POSTGRES_DB packetchat)"

# Write to a temp name and rename only on success, so a failed or half-written
# dump is never left looking like a usable backup.
pg_out="${BACKUP_DIR}/postgres-${STAMP}.dump"
log "dumping postgres (${PG_DB})"
if dc exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "${pg_out}.part"; then
  mv "${pg_out}.part" "$pg_out"
  log "wrote $(basename "$pg_out") ($(du -h "$pg_out" | cut -f1))"
else
  rm -f "${pg_out}.part"
  die "postgres dump failed"
fi

# The MinIO image ships no tar (`docker compose exec minio tar` exits 127), so
# the volume is archived by a throwaway busybox that mounts it read-only. This
# also means the archive does not depend on the MinIO container being healthy.
minio_out="${BACKUP_DIR}/minio-${STAMP}.tar"
# docker-compose.yml pins `name: packetchat`, so the volume is deterministic.
minio_volume="${PACKETCHAT_MINIO_VOLUME:-packetchat_minio-data}"
log "archiving minio volume ${minio_volume}"
if sudo -n docker run --rm -v "${minio_volume}:/data:ro" busybox:stable tar -C /data -cf - . > "${minio_out}.part"; then
  mv "${minio_out}.part" "$minio_out"
  log "wrote $(basename "$minio_out") ($(du -h "$minio_out" | cut -f1))"
else
  rm -f "${minio_out}.part"
  die "minio archive failed"
fi

# Prune oldest first, per artefact kind, so one kind failing cannot cause the
# other's history to be trimmed by the wrong count.
prune() {
  local pattern="$1" kept=0
  # shellcheck disable=SC2012 # names are timestamped, so ls -1 sorts correctly
  for file in $(ls -1t "${BACKUP_DIR}"/${pattern} 2>/dev/null || true); do
    kept=$((kept + 1))
    if [[ $kept -gt $KEEP ]]; then
      rm -f "$file"
      log "pruned $(basename "$file")"
    fi
  done
}

prune "postgres-*.dump"
prune "minio-*.tar"

log "complete; keeping the newest ${KEEP} of each artefact in ${BACKUP_DIR}"
