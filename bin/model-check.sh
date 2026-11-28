#!/bin/sh
set -eu

tla_version=1.7.4
tla_sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/.cache/model-check"
jar="$work/tla2tools-$tla_version.jar"
mkdir -p "$work"

if ! echo "$tla_sha256  $jar" | sha256sum --check --status 2>/dev/null; then
  curl --fail --silent --show-error --location --output "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$tla_version/tla2tools.jar"
  echo "$tla_sha256  $jar.part" | sha256sum --check --quiet
  mv "$jar.part" "$jar"
fi

run_check() {
  model_dir="$root/$1"
  spec=$2
  config=$3
  expected=$4
  log="$work/$config.log"
  out="$work/$config.out"
  tmp="$work/tmp/$config"
  mkdir -p "$tmp"
  status=0
  (cd "$model_dir" && java -XX:+UseParallelGC -Djava.io.tmpdir="$tmp" -cp "$jar" tlc2.TLC \
    -workers 1 -metadir "$work/states/$config" \
    -config "$config.cfg" "$spec.tla") >"$log" 2>&1 || status=$?
  states=$(grep -o '^[0-9]* states generated, [0-9]* distinct states found' "$log" | sed 's/.*, //' || true)
  if [ "$expected" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$log"; then
      echo "ok    $config passes ($states)" >"$out"
      return 0
    fi
    {
      echo "FAIL  $config was expected to pass (TLC exit $status, log $log)"
      grep '^Error:' "$log" || true
      tail -n 40 "$log"
    } >"$out"
    return 1
  fi
  if [ "$status" -eq 12 ] && grep -q "Invariant $expected is violated" "$log"; then
    echo "ok    $config violates $expected as expected (log $log)" >"$out"
    return 0
  fi
  {
    echo "FAIL  $config was expected to violate $expected (TLC exit $status, log $log)"
    grep '^Error:' "$log" || true
    tail -n 40 "$log"
  } >"$out"
  return 1
}

enqueue=src/features/feeds/__tests__/source-enqueue-model
pids=""
configs=""

spawn_check() {
  configs="$configs $3"
  run_check "$1" "$2" "$3" "$4" &
  pids="$pids $!"
}

spawn_check $enqueue SourceEnqueue current pass
spawn_check $enqueue SourceEnqueue replay-issue-813 RefreshAnsweredBeforeIdle
spawn_check $enqueue SourceEnqueue replay-d1a82e4d RefreshAnsweredBeforeIdle
spawn_check $enqueue SourceEnqueue replay-issue-845 RefreshAnsweredBeforeIdle
spawn_check $enqueue SourceEnqueue replay-issue-847 RefreshAnsweredBeforeIdle
spawn_check $enqueue SourceEnqueue replay-issue-1196 RefreshAnsweredBeforeIdle
spawn_check $enqueue SourceEnqueue replay-issue-1197 RefreshAnsweredBeforeIdle

failed=0
for pid in $pids; do
  if ! wait "$pid"; then
    failed=1
  fi
done

for config in $configs; do
  cat "$work/$config.out"
done

exit "$failed"
