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

failed=0

check() {
  model_dir="$root/$1"
  spec=$2
  config=$3
  expected=$4
  log="$work/$config.log"
  status=0
  (cd "$model_dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
    -workers 1 -metadir "$work/states/$config" \
    -config "$config.cfg" "$spec.tla") >"$log" 2>&1 || status=$?
  states=$(grep -o '[0-9]* distinct states found' "$log" || true)
  if [ "$expected" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$log"; then
      echo "ok    $config passes ($states)"
      return
    fi
    echo "FAIL  $config was expected to pass (TLC exit $status, log $log)"
  else
    if [ "$status" -eq 12 ] && grep -q "Invariant $expected is violated" "$log"; then
      echo "ok    $config violates $expected as expected (log $log)"
      return
    fi
    echo "FAIL  $config was expected to violate $expected (TLC exit $status, log $log)"
  fi
  tail -n 40 "$log"
  failed=1
}

enqueue=src/features/feeds/__tests__/source-enqueue-model
check $enqueue SourceEnqueue current pass
check $enqueue SourceEnqueue finding-strict RefreshAnsweredBeforeIdle
check $enqueue SourceEnqueue finding-marked-late RefreshAnsweredUnlessAddLost
check $enqueue SourceEnqueue finding-add-lost RefreshAnsweredUnlessMarkedLate
check $enqueue SourceEnqueue replay-issue-813 RefreshAnsweredOutsideKnownRaces
check $enqueue SourceEnqueue replay-d1a82e4d RefreshAnsweredOutsideKnownRaces
check $enqueue SourceEnqueue replay-issue-845 RefreshAnsweredOutsideKnownRaces
check $enqueue SourceEnqueue replay-issue-847 RefreshAnsweredOutsideKnownRaces

exit "$failed"
