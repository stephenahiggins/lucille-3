#!/usr/bin/env bash
set -euo pipefail

ITERATIONS="${1:-8}"
PROMPT_FILE="${PROMPT_FILE:-prompts/v1-hardening-ralf.md}"
LOG_DIR="${LOG_DIR:-logs/ralf}"
CODEX_BIN="${CODEX_BIN:-codex}"
STATUS_SCRIPT="${STATUS_SCRIPT:-scripts/summarise-ralf-status.mjs}"
RALF_SMOKE="${RALF_SMOKE:-0}"
RUN_MAKE_ANALYSE="${RUN_MAKE_ANALYSE:-1}"

run_codex_iteration() {
  local log_file="$1"
  local status=0

  if "$CODEX_BIN" exec --help >/dev/null 2>&1; then
    local help_text
    help_text="$("$CODEX_BIN" exec --help 2>/dev/null || true)"
    local args=(exec --skip-git-repo-check)

    if grep -q -- "--sandbox" <<<"$help_text"; then
      args+=(--sandbox danger-full-access)
    fi
    if grep -q -- "--ask-for-approval" <<<"$help_text"; then
      args+=(--ask-for-approval never)
    fi
    if grep -q -- "--color" <<<"$help_text"; then
      args+=(--color never)
    fi
    args+=(-)

    set +e
    "$CODEX_BIN" "${args[@]}" < "$PROMPT_FILE" 2>&1 | tee -a "$log_file"
    status=${PIPESTATUS[0]}
    set -e
  else
    set +e
    "$CODEX_BIN" < "$PROMPT_FILE" 2>&1 | tee -a "$log_file"
    status=${PIPESTATUS[0]}
    set -e
  fi

  if [ "$status" -ne 0 ]; then
    echo "Codex iteration failed with exit code $status. Continuing to checks." | tee -a "$log_file"
  fi
}

run_checks() {
  local log_file="$1"

  if [ -f package.json ]; then
    run_check "$log_file" "npm run typecheck --if-present" npm run typecheck --if-present
    run_check "$log_file" "npm test --if-present" npm test --if-present
  else
    echo "No package.json yet; skipping npm checks." | tee -a "$log_file"
  fi

  if [ "$RUN_MAKE_ANALYSE" = "1" ] && [ -f Makefile ]; then
    run_check "$log_file" "make analyse" make analyse
  fi

  if [ -n "$STATUS_SCRIPT" ] && [ -f "$STATUS_SCRIPT" ]; then
    run_check "$log_file" "node $STATUS_SCRIPT" node "$STATUS_SCRIPT"
  fi
}

run_check() {
  local log_file="$1"
  local label="$2"
  shift 2

  echo "" | tee -a "$log_file"
  echo "$label" | tee -a "$log_file"

  set +e
  "$@" 2>&1 | tee -a "$log_file"
  local status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -ne 0 ]; then
    echo "$label failed with exit code $status." | tee -a "$log_file"
  fi
}

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: iteration count must be a positive integer."
  exit 1
fi

if [ "$ITERATIONS" -lt 1 ]; then
  echo "No iterations requested."
  exit 0
fi

mkdir -p "$LOG_DIR"

if [ "$RALF_SMOKE" != "1" ] && ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "Error: Codex CLI not found: $CODEX_BIN"
  echo "Install Codex or set CODEX_BIN to the executable you want this loop to run."
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: missing prompt file: $PROMPT_FILE"
  exit 1
fi

echo "Running Lucille RALF loop for $ITERATIONS iteration(s)."
echo "Prompt: $PROMPT_FILE"
echo "Logs: $LOG_DIR"
if [ "$RALF_SMOKE" = "1" ]; then
  echo "Smoke mode: Codex execution will be skipped."
fi
echo ""

for i in $(seq 1 "$ITERATIONS"); do
  TS="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
  LOG_FILE="$LOG_DIR/ralf-${i}-${TS}.log"

  {
    echo "=========================================="
    echo "Lucille RALF iteration $i / $ITERATIONS"
    echo "Started: $TS"
    echo "Working directory: $(pwd)"
    echo "Prompt: $PROMPT_FILE"
    echo "=========================================="
  } | tee "$LOG_FILE"

  if [ "$RALF_SMOKE" = "1" ]; then
    echo "Skipping Codex execution because RALF_SMOKE=1." | tee -a "$LOG_FILE"
  else
    run_codex_iteration "$LOG_FILE"
  fi

  echo "" | tee -a "$LOG_FILE"
  echo "Running local checks..." | tee -a "$LOG_FILE"
  run_checks "$LOG_FILE"

  echo "Finished iteration $i. Log: $LOG_FILE" | tee -a "$LOG_FILE"
  echo ""
done

