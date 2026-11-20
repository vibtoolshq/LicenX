#!/usr/bin/env bash
# RSG-01: operator-controlled app-only rollout. Never run without separate approval.
set -Eeuo pipefail
umask 077

die() { printf 'RSG01_BLOCKED: %s\n' "$*" >&2; return 1; }
usage() {
  echo 'Usage: bash scripts/release-app-only.sh --check|--apply --sha FULL_40_HEX_SHA [--owner-approved --owner-recovery-confirmed]' >&2
  exit 2
}

mode="${1:-}"; [[ "$mode" == --check || "$mode" == --apply ]] || usage
shift
sha=''; approved=0; recovered=0
while (( $# )); do
  case "$1" in
    --sha) (( $# >= 2 )) || usage; sha="$2"; shift 2 ;;
    --owner-approved) approved=1; shift ;;
    --owner-recovery-confirmed) recovered=1; shift ;;
    *) usage ;;
  esac
done
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || die 'Full lowercase 40-character Git SHA required'
if [[ "$mode" == --apply ]]; then
  (( approved == 1 && recovered == 1 )) || die 'Explicit operator approval and offsite-recovery confirmation required'
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
[[ "$(git rev-parse --show-toplevel)" == "$root" ]] || die 'Repository root mismatch'
[[ "$(git rev-parse HEAD)" == "$sha" ]] || die 'Requested revision does not match checked-out HEAD'
[[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die 'Working tree contains changes'
command -v docker >/dev/null || die 'Docker not installed'

docker_cmd=(docker)
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  command -v sudo >/dev/null || die 'Docker permission denied'
  sudo -n docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || die 'Noninteractive authorized Docker access unavailable'
  docker_cmd=(sudo -n docker)
fi
compose=("${docker_cmd[@]}" compose --profile standalone-https)
"${compose[@]}" config --quiet >/dev/null || die 'Compose config validation failed'

container() {
  local id
  id="$("${compose[@]}" ps -q "$1")"
  [[ -n "$id" ]] || die "Expected service container not running: $1"
  printf '%s' "$id"
}
inspect() { "${docker_cmd[@]}" inspect --format "$1" "$2"; }
mounts() {
  inspect '{{range .Mounts}}{{if .Name}}{{.Name}}:{{.Destination}};{{end}}{{end}}' "$1"
}
healthy() {
  [[ "$(inspect '{{.State.Running}}' "$1")" == true ]] || die "Service stopped: $2"
  if [[ "$2" != caddy ]]; then
    [[ "$(inspect '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$1")" == healthy ]] || die "Service unhealthy: $2"
  fi
}
app="$(container app)"
pg="$(container postgres)"
caddy="$(container caddy)"
healthy "$app" app
healthy "$pg" postgres
healthy "$caddy" caddy

app_mount="$(mounts "$app")"
pg_mount="$(mounts "$pg")"
caddy_mount="$(mounts "$caddy")"
[[ "$app_mount" == *':/var/lib/licenx/storage;'* ]] || die 'App storage volume missing'
[[ "$pg_mount" == *':/var/lib/postgresql/data;'* ]] || die 'PostgreSQL data volume missing'
[[ "$caddy_mount" == *':/data;'* && "$caddy_mount" == *':/config;'* ]] || die 'Caddy persistent volumes missing'

# Read only the Backup Manager's minimal job/status metadata. No key, archive or credential bytes leave the container.
"${docker_cmd[@]}" exec "$app" node -e '
const fs=require("node:fs");
const path=require("node:path");
const root="/var/lib/licenx/storage/.backup-manager";
let state;
try { state=JSON.parse(fs.readFileSync(path.join(root,"state.json"),"utf8")); }
catch { process.exit(2); }
const jobs=Array.isArray(state.jobs)?state.jobs:[];
const now=Date.now(), recent=j=>Number.isFinite(j.createdAt)&&j.createdAt<=now+300000&&now-j.createdAt<=48*3600000;
const local=jobs.find(j=>j.action==="backup"&&j.status==="completed"&&recent(j)&&typeof j.file==="string"&&j.file.startsWith(root+"/archives/")&&fs.existsSync(j.file)&&fs.statSync(j.file).isFile()&&fs.statSync(j.file).size>0);
const remote=jobs.find(j=>j.action==="backup"&&j.status==="completed"&&recent(j)&&typeof j.r2Key==="string"&&j.r2Key.startsWith("licenx-full-backups/"));
let keyOk=false;
try { keyOk=fs.statSync(path.join(root,"recovery.key")).size===32; } catch {}
if (!state.recoveryDownloaded || !keyOk || jobs.some(j=>j.status==="running") || !local || !remote) process.exit(3);
console.log("BACKUP_METADATA=PASS (local + R2 job references, idle, key present)");
' || die 'Backup metadata/freshness gate failed; independent offsite restoration remains operator responsibility'

old_id="$(inspect '{{.Image}}' "$app")"
image_ref="$(inspect '{{.Config.Image}}' "$app")"
[[ "$image_ref" =~ ^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9_.-]+)?$ ]] || die 'Unsupported mutable app image reference'
[[ "$image_ref" != sha256:* ]] || die 'Cannot safely replace digest-addressed image'
printf 'RSG01_CHECK=PASS SHA=%s CURRENT_APP_IMAGE=%s\n' "$sha" "$old_id"
if [[ "$mode" == --check ]]; then
  echo 'READ_ONLY_CHECK=PASS; no Docker or repository state changed'
  exit 0
fi

# A future separately approved operator runs --apply; preserve the actually healthy v7-running image.
base_ref="${image_ref%:*}"
rollback_ref="${base_ref}:rsg01-pre-${sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if "${docker_cmd[@]}" image inspect "$rollback_ref" >/dev/null 2>&1; then die 'Rollback tag collision'; fi
"${docker_cmd[@]}" image tag "$old_id" "$rollback_ref" || die 'Failed to preserve healthy app image'
tagged=1
recreate_attempted=0
rollback_if_error() {
  local rc=$?
  trap - ERR
  if (( tagged == 1 )); then
    echo 'RSG01: failure; restoring prior app image tag and app container only' >&2
    "${docker_cmd[@]}" image tag "$old_id" "$image_ref" || echo 'RSG01: IMAGE TAG RESTORE FAILED' >&2
    if (( recreate_attempted == 1 )); then
      "${compose[@]}" up --detach --no-deps --no-build --force-recreate --wait --wait-timeout 180 app ||
        echo 'RSG01: APP ROLLBACK FAILED; manual intervention required' >&2
    fi
  fi
  exit "$rc"
}
trap rollback_if_error ERR

"${compose[@]}" build --build-arg "LICENX_SOURCE_REVISION=$sha" app
new_id="$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$image_ref")"
new_rev="$("${docker_cmd[@]}" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
[[ "$new_rev" == "$sha" ]] || die 'New app image must carry exact SHA label'

recreate_attempted=1
"${compose[@]}" up --detach --no-deps --no-build --force-recreate --wait --wait-timeout 180 app
new_app="$(container app)"
healthy "$new_app" app
[[ "$(inspect '{{.Image}}' "$new_app")" == "$new_id" ]] || die 'Running app does not match verified new image'
[[ "$(mounts "$new_app")" == "$app_mount" ]] || die 'App storage mount changed'
[[ "$(container postgres)" == "$pg" && "$(container caddy)" == "$caddy" ]] || die 'PostgreSQL/Caddy container identity changed'
[[ "$(mounts "$pg")" == "$pg_mount" && "$(mounts "$caddy")" == "$caddy_mount" ]] || die 'Persistent volume identity changed'
"${docker_cmd[@]}" exec "$new_app" node -e '
fetch("http://127.0.0.1:3000/api/ready").then(r=>{if(!r.ok)process.exit(3);return r.json()}).then(j=>{if(j.status!=="ready")process.exit(3)}).catch(()=>process.exit(3))
'
trap - ERR
printf 'RSG01_APP_ONLY_ROLLOUT=PASS SHA=%s ROLLBACK_TAG=%s\n' "$sha" "$rollback_ref"
