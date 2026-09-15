#!/usr/bin/env bash
# Invoked over SSH by deploy-relay.mjs; no local configuration or secrets uploaded.
set -Eeuo pipefail
umask 077
mode=$1
compose_file=$2
project=$3
state=$4
use_sudo=$5
docker_cmd=(docker)
if [[ "$use_sudo" == yes ]]; then docker_cmd=(sudo -n docker); fi
d() { "${docker_cmd[@]}" "$@"; }
base=(compose --project-directory "$(dirname "$compose_file")" -p "$project" -f "$compose_file")
c() { d "${base[@]}" "$@"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$mode" == check || "$mode" == deploy ]] || fail 'Invalid mode'
[[ -f "$compose_file" ]] || fail 'Existing Compose file is missing'
for tool in curl python3 flock sha256sum tar; do command -v "$tool" >/dev/null; done

# Lock before discovering the active image and volume. A second deploy must not
# snapshot a half-updated service. check never creates or changes files.
if [[ "$mode" == deploy ]]; then
  mkdir -p "$state"
  exec 9>"$state/deploy.lock"
  flock -n 9 || fail 'Another deployment is running'
fi
container=$(c ps -q relay)
[[ -n "$container" && "$container" != *$'\n'* ]] || fail 'Expected exactly one running relay'
[[ $(d inspect -f '{{.State.Running}}' "$container") == true ]] || fail 'Relay is not running'
[[ $(d inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container") == "$project" ]] || fail 'Compose project mismatch'
old_image=$(d inspect -f '{{.Image}}' "$container")
volume=$(d inspect "$container" | python3 -c '
import json,sys
mounts=[m for m in json.load(sys.stdin)[0]["Mounts"] if m["Destination"]=="/data"]
assert len(mounts)==1 and mounts[0]["Type"]=="volume", "Expected a named /data volume"
print(mounts[0]["Name"])
')
# Resolve the existing configuration without printing environment values.
c config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin); r=c["services"]["relay"]
v=[v for v in r.get("volumes",[]) if v["target"]=="/data"]
assert len(v)==1 and v[0]["type"]=="volume", "Expected a named /data volume in Compose"
assert c["volumes"][v[0]["source"]]["name"]==sys.argv[1], "Compose would select a different data volume"
' "$volume"
origin=$(d inspect "$container" | python3 -c '
import json,sys
from urllib.parse import urlsplit
env=json.load(sys.stdin)[0]["Config"]["Env"]
origin=next(e.split("=",1)[1] for e in env if e.startswith("MOOR_ORIGIN="))
u=urlsplit(origin)
assert u.scheme=="https" and u.hostname and not u.username and not u.password and u.path in ("", "/") and not u.query and not u.fragment, "Expected an HTTPS origin"
print(origin.rstrip("/"))
')
public_health() {
  curl --fail --silent --show-error --connect-timeout 10 --max-time 20 "$origin/healthz" |
    python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True'
}
public_health
printf 'SSH/Docker/HTTPS OK: project=%s volume=%s origin=%s\n' "$project" "$volume" "$origin"
[[ "$mode" == deploy ]] || exit 0

archive=$6
digest=$7
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid package checksum'
[[ $(sha256sum "$archive" | cut -d ' ' -f 1) == "$digest" ]] || fail 'Package checksum mismatch'
release=$(mktemp -d "$state/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
mkdir "$release/program"
tar -xzf "$archive" -C "$release/program" --no-same-owner
image="moor-relay:deploy-${digest:0:16}-$(basename "$release" | tr '[:upper:]' '[:lower:]')"
d build --tag "$image" "$release/program/relay"

# Both overrides pin the actual image and retain the original volumes, env,
# networks, and HTTPS service. They remain available for operator recovery.
python3 - "$release" "$image" "$old_image" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
for name,image in [("next.json",sys.argv[2]), ("previous.json",sys.argv[3])]:
    (root/name).write_text(json.dumps({"services":{"relay":{"image":image,"pull_policy":"never"}}})+"\n")
PY
next() { d "${base[@]}" -f "$release/next.json" "$@"; }
# Validate the merged config before downtime.
next config --quiet
phase=running
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [[ $result -ne 0 ]]; then
    if [[ "$phase" == stopped ]]; then
      # No new application has opened the database; restarting the exact old
      # container is safe even if backup failed.
      d start "$container" >/dev/null || printf 'Could not restart original relay\n' >&2
    elif [[ "$phase" == activating ]]; then
      # The new program may have migrated data. Never restore old data or start
      # an older binary automatically once activation has been attempted.
      next stop relay || true
      printf 'Activation failed; relay stopped. Recovery files: %s\n' "$release" >&2
      printf 'Backup: %s/data.tar.gz. Review migrations before restoring data or previous.json.\n' "$release" >&2
    fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
phase=stopped
c stop relay
# Reading a stopped volume avoids inconsistent SQLite/WAL copies. The archive
# stays private on the VPS, outside the Docker context and program archive.
d run --rm --network none --user 0 --entrypoint tar \
  --mount "type=volume,src=$volume,dst=/data,readonly" \
  "$old_image" -C /data -czf - . > "$release/data.tar.gz.partial"
tar -tzf "$release/data.tar.gz.partial" >/dev/null
mv "$release/data.tar.gz.partial" "$release/data.tar.gz"
printf '%s\n' "$volume" > "$release/volume"
printf '%s\n' "$digest" > "$release/sha256"
phase=activating
next up -d --no-deps --no-build --pull never --force-recreate relay
new_container=$(next ps -q relay)
[[ $(d inspect -f '{{.Image}}' "$new_container") == $(d image inspect -f '{{.Id}}' "$image") ]] || fail 'Running image mismatch'
# Bounded readiness polling runs inside the container. Tests inject Docker
# responses and do not use real accounts, network delays, or sleeps.
d exec "$new_container" node -e '
(async()=>{
  for(let attempt=0; attempt<30; attempt++) {
    try {
      const r=await fetch("http://127.0.0.1:3078/healthz", {signal:AbortSignal.timeout(2000)});
      if(r.ok && (await r.json()).ok===true) return;
    } catch {}
    if(attempt<29) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  process.exitCode=1;
})().catch(()=>{process.exitCode=1});'
public_health
cp "$release/next.json" "$state/current.json.tmp"
mv "$state/current.json.tmp" "$state/current.json"
phase=complete
printf 'Deployed %s\nBackup and previous image: %s\n' "$image" "$release"
printf 'For future manual Compose commands add: -f %s/current.json\n' "$state"
