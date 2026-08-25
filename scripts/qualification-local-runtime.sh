#!/usr/bin/env bash
# Deterministic Ubuntu lifecycle for the two frozen local qualification targets.
# This script never pulls an image, downloads model data, or touches GPU 0.

set -Eeuo pipefail
umask 077

readonly STAGE_ID="plinius-qualification-2026-08-22-diagnostic-one-shot-r1"
readonly IMAGE="vllm/vllm-openai@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967"
readonly IMAGE_VERSION="0.27.1"
readonly QWEN_NAME="vllm-qwen"
readonly QWEN_MODEL="Qwen/Qwen3.8-27B"
readonly QWEN_REVISION="1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"
readonly QWEN_CACHE_ROOT="/data/hf-cache"
readonly QWEN_SNAPSHOT="${QWEN_CACHE_ROOT}/hub/models--Qwen--Qwen3.8-27B/snapshots/${QWEN_REVISION}"
readonly GPTOSS_NAME="vllm-gptoss"
readonly GPTOSS_MODEL="openai/gpt-oss-20b"
readonly GPTOSS_REVISION="6cee5e81ee83917806bbde320786a8fb61efebee"
readonly GPTOSS_CACHE_ROOT="/home/ubuntu/.cache/huggingface"
readonly GPTOSS_SNAPSHOT="${GPTOSS_CACHE_ROOT}/hub/models--openai--gpt-oss-20b/snapshots/${GPTOSS_REVISION}"
readonly LABEL_KEY="org.plinius.qualification-stage"
readonly MAX_IDLE_GPU_MIB=1024
readonly HEALTH_TIMEOUT_SECONDS=1800

ROLLBACK_DEEPWIKI_ID=""

readonly A100_PREFLIGHT_SHA="30ffa0e7d8d10b1470c66519c4aae7af71139977f339d46ffc5b9b2c0b4a2db0"
readonly QWEN_CHECKPOINT_SHA="9eac6a8940991f17e25af6b6a0c1107d2934aa6eb13893fba09b351e39b82c31"
readonly GPTOSS_CHECKPOINT_SHA="b75d875327d58a1e8cc91d7f2ae0c4091d65e839ffb923f58cbda4c0e9fe35c9"
readonly CATALOG_RESOLUTION_SHA="8bd4fa2d78d2545f7c80da5d0fd9081250f8cf68cad7715f2c5d38dcfb16ce44"

QWEN_ARGS=(
  serve --model "$QWEN_MODEL" --revision "$QWEN_REVISION"
  --served-model-name "$QWEN_MODEL" --tensor-parallel-size 2 --dtype bfloat16
  --max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1
)
GPTOSS_ARGS=(
  serve --model "$GPTOSS_MODEL" --revision "$GPTOSS_REVISION"
  --served-model-name "$GPTOSS_MODEL" --tensor-parallel-size 1
  --max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1
)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  qualification-local-runtime.sh plan
  qualification-local-runtime.sh preflight
  qualification-local-runtime.sh deploy
  qualification-local-runtime.sh status
  qualification-local-runtime.sh teardown

Required for preflight/deploy:
  PARENT_EVIDENCE_ROOT         Verified extracted parent Evidence root
  PLINIUS_DEEPWIKI_CONTAINER  Running Docker container currently owning port 8001

Required for deploy/status/teardown:
  PLINIUS_RUNTIME_STATE       Absolute path to the lifecycle state JSON
EOF
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_absolute() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path" ;;
  esac
}

json_array() {
  jq -cn '$ARGS.positional' --args -- "$@"
}

print_plan() {
  jq -n \
    --arg stage "$STAGE_ID" \
    --arg image "$IMAGE" \
    --arg qwenName "$QWEN_NAME" \
    --arg qwenModel "$QWEN_MODEL" \
    --arg qwenRevision "$QWEN_REVISION" \
    --arg qwenSnapshot "$QWEN_SNAPSHOT" \
    --argjson qwenArgs "$(json_array "${QWEN_ARGS[@]}")" \
    --arg gptossName "$GPTOSS_NAME" \
    --arg gptossModel "$GPTOSS_MODEL" \
    --arg gptossRevision "$GPTOSS_REVISION" \
    --arg gptossSnapshot "$GPTOSS_SNAPSHOT" \
    --argjson gptossArgs "$(json_array "${GPTOSS_ARGS[@]}")" \
    '{schemaVersion:1, stageId:$stage, image:$image, networkDownloads:false, targets:[
      {container:$qwenName, model:$qwenModel, revision:$qwenRevision, endpoint:"http://localhost:8001/v1", gpus:[1,2], snapshot:$qwenSnapshot, engineArgv:$qwenArgs},
      {container:$gptossName, model:$gptossModel, revision:$gptossRevision, endpoint:"http://localhost:8002/v1", gpus:[3], snapshot:$gptossSnapshot, engineArgv:$gptossArgs}
    ]}'
}

verify_parent_artifact() {
  local relative=$1
  local expected=$2
  local path="${PARENT_EVIDENCE_ROOT}/${relative}"
  local actual
  [[ -f "$path" && ! -L "$path" ]] || die "parent artifact is not a regular non-symlink: $relative"
  actual=$(sha256sum "$path" | awk '{print $1}')
  [[ "$actual" == "$expected" ]] || die "parent artifact digest mismatch: $relative"
}

verify_snapshot() {
  local path=$1
  local revision=$2
  local resolved
  [[ -d "$path" && ! -L "$path" ]] || die "snapshot is not a real directory: $path"
  resolved=$(realpath -e "$path")
  [[ "${resolved##*/}" == "$revision" ]] || die "snapshot basename does not match revision: $path"
}

verify_local_image() {
  local image_json version
  image_json=$(docker image inspect "$IMAGE" 2>/dev/null) || die "pinned image is absent locally; image pull is prohibited"
  jq -e --arg image "$IMAGE" 'length == 1 and (.[0].RepoDigests | index($image)) != null' \
    <<<"$image_json" >/dev/null || die "local image RepoDigests do not contain the pinned digest"
  version=$(jq -r '.[0].Config.Labels["org.opencontainers.image.version"] // .[0].Config.Labels["vllm.version"] // .[0].Config.Labels.version // empty' <<<"$image_json")
  [[ "$version" == "$IMAGE_VERSION" ]] || die "local image version label is absent or not ${IMAGE_VERSION}"
}

container_process_json() {
  docker inspect --type container "$1" | jq -c '.[0] | {id:.Id,name:(.Name|ltrimstr("/")),running:.State.Running,path:.Path,args:.Args,image:.Config.Image}'
}

verify_deepwiki() {
  local info
  info=$(container_process_json "$PLINIUS_DEEPWIKI_CONTAINER") || die "deepwiki must be a Docker-managed container"
  jq -e '
    .running == true and
    (([.path] + .args) as $a |
      ($a | index("-m")) as $m |
      ($a | index("--port")) as $p |
      $m != null and $a[$m + 1] == "api.main" and
      $p != null and $a[$p + 1] == "8001")
  ' <<<"$info" >/dev/null || die "deepwiki live process is not the approved python -m api.main --port 8001 shape"
  jq -r '.id' <<<"$info"
}

assert_target_names_absent() {
  local name
  for name in "$QWEN_NAME" "$GPTOSS_NAME"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      die "qualification container already exists: $name"
    fi
  done
}

port_is_listening() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

assert_port_free() {
  port_is_listening "$1" && die "TCP port $1 is already listening"
}

assert_qualification_gpus_idle() {
  local index name used count=0 seen1=0 seen2=0 seen3=0
  while IFS=, read -r index name used; do
    index=${index//[[:space:]]/}
    name=${name#"${name%%[![:space:]]*}"}
    name=${name%"${name##*[![:space:]]}"}
    used=${used//[[:space:]]/}
    [[ "$index" =~ ^[0-7]$ ]] || die "unexpected GPU index: $index"
    [[ "$name" == "NVIDIA A100-SXM4-40GB" ]] || die "unexpected GPU model at index ${index}: $name"
    count=$((count + 1))
    case "$index" in
      1|2|3)
        [[ "$used" =~ ^[0-9]+$ ]] || die "cannot parse GPU ${index} memory usage"
        (( used <= MAX_IDLE_GPU_MIB )) || die "GPU ${index} is not idle (${used} MiB used)"
        case "$index" in
          1) seen1=1 ;;
          2) seen2=1 ;;
          3) seen3=1 ;;
        esac
        ;;
    esac
  done < <(nvidia-smi --query-gpu=index,name,memory.used --format=csv,noheader,nounits)
  (( count == 8 && seen1 == 1 && seen2 == 1 && seen3 == 1 )) || die "host must expose exactly eight GPUs including 1, 2 and 3"
}

preflight() {
  require_command docker
  require_command jq
  require_command sha256sum
  require_command nvidia-smi
  require_command realpath
  require_command ss
  [[ "$(uname -s)" == "Linux" ]] || die "deployment is supported only on Linux"
  [[ -n "${PARENT_EVIDENCE_ROOT:-}" ]] || die "PARENT_EVIDENCE_ROOT is required"
  [[ -n "${PLINIUS_DEEPWIKI_CONTAINER:-}" ]] || die "PLINIUS_DEEPWIKI_CONTAINER is required"
  require_absolute PARENT_EVIDENCE_ROOT "$PARENT_EVIDENCE_ROOT"
  [[ -d "$PARENT_EVIDENCE_ROOT" && ! -L "$PARENT_EVIDENCE_ROOT" ]] || die "parent Evidence root is invalid"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"

  verify_parent_artifact artifacts/06-a100-preflight.json "$A100_PREFLIGHT_SHA"
  verify_parent_artifact artifacts/06-local-checkpoint-qwen3.8-27b.json "$QWEN_CHECKPOINT_SHA"
  verify_parent_artifact artifacts/06-local-checkpoint-gpt-oss-20b.json "$GPTOSS_CHECKPOINT_SHA"
  verify_parent_artifact artifacts/05-openrouter-catalog-and-resolution.json "$CATALOG_RESOLUTION_SHA"
  verify_snapshot "$QWEN_SNAPSHOT" "$QWEN_REVISION"
  verify_snapshot "$GPTOSS_SNAPSHOT" "$GPTOSS_REVISION"
  verify_local_image
  assert_target_names_absent
  assert_port_free 8002
  assert_qualification_gpus_idle
  verify_deepwiki >/dev/null
  printf 'LOCAL_RUNTIME_PREFLIGHT_OK\n'
}

state_file_checks() {
  local parent mode owner resolved
  [[ -n "${PLINIUS_RUNTIME_STATE:-}" ]] || die "PLINIUS_RUNTIME_STATE is required"
  require_absolute PLINIUS_RUNTIME_STATE "$PLINIUS_RUNTIME_STATE"
  [[ ! -L "$PLINIUS_RUNTIME_STATE" ]] || die "state path must not be a symlink"
  parent=${PLINIUS_RUNTIME_STATE%/*}
  [[ -d "$parent" && ! -L "$parent" ]] || die "state parent must be a real directory"
  resolved=$(realpath -e "$parent")
  [[ "$resolved" == "$parent" ]] || die "state parent must use its canonical path"
  mode=$(stat -c '%a' "$parent")
  owner=$(stat -c '%u' "$parent")
  [[ "$owner" == "$(id -u)" ]] || die "state parent must be owned by the executing uid"
  (( (8#$mode & 077) == 0 )) || die "state parent must not grant group or other permissions"
}

reserve_state() {
  (set -o noclobber; : >"$PLINIUS_RUNTIME_STATE") 2>/dev/null || die "runtime state was created concurrently"
  chmod 0600 "$PLINIUS_RUNTIME_STATE"
}

write_state() {
  local phase=$1
  local deepwiki_id=$2
  local qwen_id=${3:-}
  local gptoss_id=${4:-}
  local tmp="${PLINIUS_RUNTIME_STATE}.tmp.$$"
  jq -n \
    --arg stage "$STAGE_ID" --arg phase "$phase" --arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg deepwikiId "$deepwiki_id" --arg deepwikiName "$PLINIUS_DEEPWIKI_CONTAINER" \
    --arg qwenId "$qwen_id" --arg gptossId "$gptoss_id" \
    '{schemaVersion:1,stageId:$stage,phase:$phase,updatedAtUtc:$updated,
      deepwiki:{id:$deepwikiId,name:$deepwikiName},
      qualification:{qwen:{id:$qwenId,name:"vllm-qwen"},gptoss:{id:$gptossId,name:"vllm-gptoss"}}}' >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$PLINIUS_RUNTIME_STATE"
}

verify_container_plan() {
  local name=$1
  local expected_args_json=$2
  local host_port=$3
  local cache_root=$4
  local device_ids_json=$5
  local info
  info=$(docker inspect --type container "$name") || die "cannot inspect created container: $name"
  jq -e \
    --arg image "$IMAGE" --arg label "$LABEL_KEY" --arg stage "$STAGE_ID" \
    --arg hostPort "$host_port" --arg cacheRoot "$cache_root" \
    --argjson args "$expected_args_json" --argjson deviceIds "$device_ids_json" '
    length == 1 and .[0].Config.Image == $image and .[0].Path == "vllm" and .[0].Args == $args and
    .[0].Config.Labels[$label] == $stage and .[0].HostConfig.RestartPolicy.Name == "no" and
    .[0].HostConfig.IpcMode == "host" and
    .[0].HostConfig.PortBindings["8000/tcp"] == [{HostIp:"127.0.0.1",HostPort:$hostPort}] and
    ([.[0].Mounts[] | select(.Type == "bind" and .Source == $cacheRoot and .Destination == $cacheRoot and .RW == false)] | length) == 1 and
    ([.[0].HostConfig.DeviceRequests[]?.DeviceIDs] | index($deviceIds)) != null and
    (.[0].Config.Env | index("HF_HUB_CACHE=" + $cacheRoot + "/hub")) != null and
    (.[0].Config.Env | index("HF_HUB_OFFLINE=1")) != null and
    (.[0].Config.Env | index("TRANSFORMERS_OFFLINE=1")) != null and
    ([.[0].Config.Env[] | select(startswith("HF_TOKEN=") or startswith("HUGGING_FACE_HUB_TOKEN="))] | length) == 0
  ' <<<"$info" >/dev/null || die "created container does not match the frozen plan: $name"
}

create_qwen() {
  docker create --pull never --name "$QWEN_NAME" \
    --label "${LABEL_KEY}=${STAGE_ID}" --restart no --gpus '"device=1,2"' --ipc host \
    --publish 127.0.0.1:8001:8000 \
    --mount "type=bind,src=${QWEN_CACHE_ROOT},dst=${QWEN_CACHE_ROOT},readonly" \
    --env "HF_HUB_CACHE=${QWEN_CACHE_ROOT}/hub" --env HF_HUB_OFFLINE=1 --env TRANSFORMERS_OFFLINE=1 \
    --log-driver local --log-opt max-size=50m --log-opt max-file=2 \
    --entrypoint vllm "$IMAGE" "${QWEN_ARGS[@]}"
}

create_gptoss() {
  docker create --pull never --name "$GPTOSS_NAME" \
    --label "${LABEL_KEY}=${STAGE_ID}" --restart no --gpus device=3 --ipc host \
    --publish 127.0.0.1:8002:8000 \
    --mount "type=bind,src=${GPTOSS_CACHE_ROOT},dst=${GPTOSS_CACHE_ROOT},readonly" \
    --env "HF_HUB_CACHE=${GPTOSS_CACHE_ROOT}/hub" --env HF_HUB_OFFLINE=1 --env TRANSFORMERS_OFFLINE=1 \
    --log-driver local --log-opt max-size=50m --log-opt max-file=2 \
    --entrypoint vllm "$IMAGE" "${GPTOSS_ARGS[@]}"
}

wait_for_model() {
  local endpoint=$1
  local model=$2
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl --silent --show-error --fail --max-time 5 "${endpoint}/models" 2>/dev/null | \
      jq -e --arg model "$model" '([.data[]?.id] | length) == 1 and .data[0].id == $model' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

cleanup_qualification_container() {
  local name=$1
  local label
  if ! docker container inspect "$name" >/dev/null 2>&1; then
    return 0
  fi
  label=$(docker inspect --format "{{ index .Config.Labels \"${LABEL_KEY}\" }}" "$name")
  if [[ "$label" != "$STAGE_ID" ]]; then
    printf 'ERROR: refusing to remove container without qualification label: %s\n' "$name" >&2
    return 1
  fi
  docker stop --time 30 "$name" >/dev/null 2>&1 || true
  docker rm "$name" >/dev/null
}

rollback_deploy() {
  local deepwiki_id=$1
  trap - EXIT ERR INT TERM
  cleanup_qualification_container "$QWEN_NAME" || true
  cleanup_qualification_container "$GPTOSS_NAME" || true
  if [[ -n "$deepwiki_id" ]] && docker container inspect "$deepwiki_id" >/dev/null 2>&1; then
    docker start "$deepwiki_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "${PLINIUS_RUNTIME_STATE:-}" && -f "$PLINIUS_RUNTIME_STATE" ]]; then
    write_state rolled_back "$deepwiki_id" "" "" || true
  fi
}

deploy_exit_handler() {
  local status=$1
  trap - EXIT ERR INT TERM
  if (( status != 0 )); then
    rollback_deploy "$ROLLBACK_DEEPWIKI_ID"
  fi
  exit "$status"
}

deploy() {
  local deepwiki_id qwen_id gptoss_id
  state_file_checks
  [[ ! -e "$PLINIUS_RUNTIME_STATE" ]] || die "runtime state already exists; deploy is not resumable"
  preflight
  deepwiki_id=$(verify_deepwiki)
  ROLLBACK_DEEPWIKI_ID=$deepwiki_id
  reserve_state
  write_state prepared "$deepwiki_id" "" ""
  # EXIT catches explicit die()/exit paths as well as set -e failures. ERR alone
  # would leave deepwiki stopped when a post-stop validation calls die().
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'deploy_exit_handler $?' EXIT

  docker stop --time 30 "$deepwiki_id" >/dev/null
  sleep 2
  assert_port_free 8001
  write_state deepwiki_stopped "$deepwiki_id" "" ""

  qwen_id=$(create_qwen)
  verify_container_plan "$QWEN_NAME" "$(json_array "${QWEN_ARGS[@]}")" 8001 "$QWEN_CACHE_ROOT" '["1","2"]'
  write_state qwen_created "$deepwiki_id" "$qwen_id" ""
  gptoss_id=$(create_gptoss)
  verify_container_plan "$GPTOSS_NAME" "$(json_array "${GPTOSS_ARGS[@]}")" 8002 "$GPTOSS_CACHE_ROOT" '["3"]'
  write_state containers_created "$deepwiki_id" "$qwen_id" "$gptoss_id"

  docker start "$QWEN_NAME" "$GPTOSS_NAME" >/dev/null
  write_state containers_started "$deepwiki_id" "$qwen_id" "$gptoss_id"
  # Both models load concurrently after docker start. Keep health checks in this
  # process so ERR handling has exactly one rollback owner.
  wait_for_model http://localhost:8001/v1 "$QWEN_MODEL"
  wait_for_model http://localhost:8002/v1 "$GPTOSS_MODEL"

  write_state deployed "$deepwiki_id" "$qwen_id" "$gptoss_id"
  trap - EXIT ERR INT TERM
  printf 'LOCAL_RUNTIME_DEPLOYED state=%s\n' "$PLINIUS_RUNTIME_STATE"
}

read_state() {
  state_file_checks
  [[ -f "$PLINIUS_RUNTIME_STATE" ]] || die "runtime state does not exist"
  local mode owner
  mode=$(stat -c '%a' "$PLINIUS_RUNTIME_STATE")
  owner=$(stat -c '%u' "$PLINIUS_RUNTIME_STATE")
  [[ "$mode" == "600" && "$owner" == "$(id -u)" ]] || die "runtime state must be mode 0600 and owned by the executing uid"
  jq -e --arg stage "$STAGE_ID" '.schemaVersion == 1 and .stageId == $stage' "$PLINIUS_RUNTIME_STATE" >/dev/null || die "runtime state schema or stage mismatch"
  cat "$PLINIUS_RUNTIME_STATE"
}

status_runtime() {
  local state
  state=$(read_state)
  jq . <<<"$state"
  for name in "$QWEN_NAME" "$GPTOSS_NAME"; do
    docker inspect --format '{{.Name}} running={{.State.Running}} id={{.Id}}' "$name" 2>/dev/null || true
  done
}

teardown() {
  local state phase deepwiki_id deepwiki_name qwen_id gptoss_id actual
  state=$(read_state)
  phase=$(jq -r '.phase' <<<"$state")
  [[ "$phase" != "restored" ]] || die "runtime was already restored"
  deepwiki_id=$(jq -r '.deepwiki.id' <<<"$state")
  deepwiki_name=$(jq -r '.deepwiki.name' <<<"$state")
  qwen_id=$(jq -r '.qualification.qwen.id' <<<"$state")
  gptoss_id=$(jq -r '.qualification.gptoss.id' <<<"$state")
  PLINIUS_DEEPWIKI_CONTAINER=$deepwiki_name

  if docker container inspect "$QWEN_NAME" >/dev/null 2>&1; then
    actual=$(docker inspect --format '{{.Id}}' "$QWEN_NAME")
    [[ -z "$qwen_id" || "$actual" == "$qwen_id" ]] || die "Qwen container identity changed"
  fi
  if docker container inspect "$GPTOSS_NAME" >/dev/null 2>&1; then
    actual=$(docker inspect --format '{{.Id}}' "$GPTOSS_NAME")
    [[ -z "$gptoss_id" || "$actual" == "$gptoss_id" ]] || die "gpt-oss container identity changed"
  fi
  cleanup_qualification_container "$QWEN_NAME"
  cleanup_qualification_container "$GPTOSS_NAME"
  assert_port_free 8002

  actual=$(docker inspect --format '{{.Id}}' "$deepwiki_id") || die "recorded deepwiki container no longer exists"
  [[ "$actual" == "$deepwiki_id" ]] || die "deepwiki container identity changed"
  docker start "$deepwiki_id" >/dev/null
  local deadline=$((SECONDS + 120))
  until port_is_listening 8001; do
    (( SECONDS < deadline )) || die "deepwiki did not restore port 8001"
    sleep 2
  done
  write_state restored "$deepwiki_id" "" ""
  printf 'LOCAL_RUNTIME_TORN_DOWN_AND_DEEPWIKI_RESTORED state=%s\n' "$PLINIUS_RUNTIME_STATE"
}

main() {
  local command=${1:-}
  [[ $# -eq 1 ]] || usage
  case "$command" in
    plan)
      require_command jq
      print_plan
      ;;
    preflight)
      preflight
      ;;
    deploy)
      deploy
      ;;
    status)
      status_runtime
      ;;
    teardown)
      teardown
      ;;
    *) usage ;;
  esac
}

main "$@"
