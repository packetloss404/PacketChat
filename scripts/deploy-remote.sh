#!/usr/bin/env bash
# Deploy PacketChat to a remote Docker host.
#
# Authenticates ONCE via an SSH control socket, then multiplexes every
# subsequent ssh/scp call over that connection - so you type your password
# a single time no matter how many remote steps run.
#
#   ./scripts/deploy-remote.sh [--host H] [--user U] [--dir D] [--port P] [--no-build]
# NOTE: --env-file is mandatory. Compose resolves ${VAR} interpolation from the
# .env beside the compose FILE (infrastructure/compose/), not the repo root, so
# without it Postgres and MinIO silently initialise with the fallback dev
# passwords while the apps read the real ones via env_file, and auth fails.
set -euo pipefail

HOST="${DEPLOY_HOST:-10.80.12.12}"
USER_NAME="${DEPLOY_USER:-ianwalmsley}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/stacks/packetchat}"
WEB_PORT="${PACKETCHAT_WEB_PORT:-3020}"
DO_BUILD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --dir)  REMOTE_DIR="$2"; shift 2 ;;
    --port) WEB_PORT="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

TARGET="${USER_NAME}@${HOST}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CTL="$(mktemp -u "${TMPDIR:-/tmp}/pc-deploy-%r@%h-XXXXXX")"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=${CTL}" -o ControlPersist=10m -o StrictHostKeyChecking=accept-new)

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() { ssh -O exit -o "ControlPath=${CTL}" "$TARGET" 2>/dev/null || true; }
trap cleanup EXIT

rsh()  { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
dc()   { rsh "cd '$REMOTE_DIR' && PACKETCHAT_WEB_PORT='${WEB_PORT}' sudo -n docker compose -f infrastructure/compose/docker-compose.yml --env-file '${REMOTE_DIR}/.env' $*"; }

# ---------------------------------------------------------------- preflight
[[ -d .git ]] || die "run this from the repository root"
git diff --quiet HEAD 2>/dev/null || warn "working tree has uncommitted changes; deploying committed HEAD only"

log "Connecting to ${TARGET} (you will be prompted for the password once)"
rsh 'echo "connected as $(whoami) on $(hostname)"' || die "ssh failed"

log "Checking remote prerequisites"
rsh 'command -v docker >/dev/null || { echo "docker missing"; exit 1; }
     docker compose version >/dev/null 2>&1 || { echo "docker compose v2 missing"; exit 1; }
     sudo -n docker info >/dev/null 2>&1 || { echo "cannot reach docker daemon via sudo -n"; exit 1; }
     echo "docker ok: $(docker --version)"' || die "remote prerequisites not met"

# On a redeploy our own web container legitimately holds the port, so only
# refuse when something else does.
if rsh "ss -ltn 2>/dev/null | grep -q ':${WEB_PORT} '"; then
  if rsh "sudo -n docker ps --filter 'name=packetchat-web' --format '{{.Names}}' | grep -q ."; then
    echo "port ${WEB_PORT} held by the existing packetchat stack (redeploy)"
  else
    die "port ${WEB_PORT} already in use on ${HOST} by something else. Re-run with --port <free-port>"
  fi
else
  echo "port ${WEB_PORT} is free"
fi

# ------------------------------------------------------------------ payload
log "Packaging committed HEAD ($(git rev-parse --short HEAD))"
TARBALL="$(mktemp "${TMPDIR:-/tmp}/packetchat-XXXXXX.tar.gz")"
git archive --format=tar.gz -o "$TARBALL" HEAD
echo "archive: $(du -h "$TARBALL" | cut -f1)"

log "Uploading to ${HOST}"
rsh "mkdir -p '$REMOTE_DIR' '${REMOTE_DIR}/.releases'"
scp "${SSH_OPTS[@]}" -q "$TARBALL" "${TARGET}:${REMOTE_DIR}/.releases/${STAMP}.tar.gz"
rm -f "$TARBALL"

# Keep the previous .env and take a snapshot we can roll back to.
log "Snapshotting current release"
rsh "cd '$REMOTE_DIR'
     if [ -f docker-compose-deployed ] || [ -d infrastructure ]; then
       tar czf '.releases/rollback-${STAMP}.tar.gz' --exclude=.releases --exclude=.env . 2>/dev/null || true
       echo 'rollback snapshot saved'
     else
       echo 'no existing release to snapshot (first deploy)'
     fi"

log "Extracting release ${STAMP}"
rsh "cd '$REMOTE_DIR' && tar xzf '.releases/${STAMP}.tar.gz' && touch docker-compose-deployed && echo extracted"

# --------------------------------------------------------------------- env
log "Verifying .env"
if ! rsh "[ -f '${REMOTE_DIR}/.env' ]"; then
  rsh "cp '${REMOTE_DIR}/.env.example' '${REMOTE_DIR}/.env'"
  cat <<EOF

  ${REMOTE_DIR}/.env did not exist. A template was copied from .env.example.

  It contains PLACEHOLDER secrets and the stack will not work until you edit it:

    ssh ${TARGET}
    \$EDITOR ${REMOTE_DIR}/.env

  Set at minimum: BOOTSTRAP_TOKEN, JWT_SECRET, ENCRYPTION_KEY_BASE64,
  POSTGRES_PASSWORD, APP_BASE_URL, and COOKIE_SECURE=true behind HTTPS.

  Generate strong values with:
    openssl rand -hex 32          # BOOTSTRAP_TOKEN / JWT_SECRET
    openssl rand -base64 32       # ENCRYPTION_KEY_BASE64

  Then re-run this script.

EOF
  die "populate .env on the server, then re-run"
fi

MISSING="$(rsh "cd '$REMOTE_DIR' && for k in BOOTSTRAP_TOKEN JWT_SECRET ENCRYPTION_KEY_BASE64 POSTGRES_PASSWORD; do
    v=\$(grep -E \"^\${k}=\" .env | cut -d= -f2-)
    if [ -z \"\$v\" ] || echo \"\$v\" | grep -qiE 'change|placeholder|replace|example|xxx'; then echo \$k; fi
  done")"
[[ -z "$MISSING" ]] || die "these .env values are unset or still placeholders: $(echo $MISSING | tr '\n' ' ')"
echo ".env looks populated"

# ------------------------------------------------------------------ deploy
if [[ $DO_BUILD -eq 1 ]]; then
  log "Building images on ${HOST} (this can take several minutes)"
  dc "build" || die "image build failed"
fi

log "Starting datastores"
dc "up -d postgres redis minio" || die "failed to start datastores"

log "Waiting for datastores to report healthy"
rsh "for i in \$(seq 1 60); do
       unhealthy=\$(docker ps --filter 'name=packetchat-' --format '{{.Names}} {{.Status}}' | grep -c 'health: starting\|unhealthy' || true)
       [ \"\$unhealthy\" = '0' ] && { echo 'datastores healthy'; exit 0; }
       sleep 3
     done; echo 'timed out waiting for health'; exit 1" || die "datastores never became healthy"

log "Initialising object storage buckets"
dc "up minio-init" || warn "bucket init reported errors; continuing"

log "Running database migrations"
dc "--profile tools run --rm migrate" || die "migrations failed - stack not started"

log "Starting application services"
dc "up -d web worker" || die "failed to start app services"

# ------------------------------------------------------------------ verify
log "Verifying HTTP response"
if rsh "for i in \$(seq 1 40); do
          code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${WEB_PORT}/login || true)
          [ \"\$code\" = '200' ] && { echo \"/login -> 200\"; exit 0; }
          sleep 3
        done; echo \"last status: \$code\"; exit 1"; then
  log "Deploy succeeded"
else
  warn "web did not return 200 - recent logs follow"
  dc "logs --tail 40 web" || true
  die "deploy finished but web is not healthy. Roll back with: tar xzf ${REMOTE_DIR}/.releases/rollback-${STAMP}.tar.gz -C ${REMOTE_DIR}"
fi

log "Container status"
dc "ps"

cat <<EOF

  Deployed ${STAMP} (commit $(git rev-parse --short HEAD)) to ${TARGET}:${REMOTE_DIR}
  Web:      http://${HOST}:${WEB_PORT}
  Logs:     ssh ${TARGET} 'cd ${REMOTE_DIR} && docker compose -f infrastructure/compose/docker-compose.yml logs -f web'
  Rollback: ssh ${TARGET} 'tar xzf ${REMOTE_DIR}/.releases/rollback-${STAMP}.tar.gz -C ${REMOTE_DIR}'

EOF
