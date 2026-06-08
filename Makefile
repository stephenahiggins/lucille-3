DAY ?= $(shell date +%F)
-include .env
CAPTURE_INTERVAL ?= 3
OPERATOR_SMOKE_CAPTURE_COUNT ?= 3
OPERATOR_SMOKE_CAPTURE_INTERVAL ?= $(CAPTURE_INTERVAL)
MODEL ?= $(LUCILLE_LOCAL_MODEL)
PROVIDER ?= auto
ANALYSE_LIMIT ?=
ANALYSE_OFFSET ?= 0
SLIDES ?=
DEBUG_DIR ?= debug
DEBUG_FRAME ?=
DEBUG_OFFSET ?= 0
OPENAI ?= auto
OPENAI_MODEL ?= $(LUCILLE_OPENAI_MODEL)
EVAL_MODELS ?= $(LUCILLE_EVAL_MODELS)
REASONING_EFFORT ?= medium
DEDUPE ?= 1
DELETE_RAW_MEDIA ?= 0
APPROVE_EXPORT ?= 0
PROPOSAL ?=
UI_PORT ?= 4173
CODEX_BIN ?= codex
NODE ?= node
NPM ?= npm
CLI ?= dist/cli.js

.PHONY: help dirs build capture capture-permission capture-pause capture-resume capture-stop capture-once analyse debug-analysis debug-frame report model-eval export-skill ui recording-dist dist-ui-recording operator-smoke-preflight operator-smoke operator-smoke-existing verify-mmp status ralf ralf-mmp ralf-closeout

help:
	@echo "Lucille commands"
	@echo "  make capture        # capture visible frames every $(CAPTURE_INTERVAL)s; Ctrl-C to stop"
	@echo "  make analyse DAY=$(DAY) MODEL=$(MODEL) PROVIDER=$(PROVIDER) ANALYSE_LIMIT=$(ANALYSE_LIMIT) OPENAI=$(OPENAI) DEDUPE=$(DEDUPE)"
	@echo "  make debug-analysis DAY=$(DAY) PROVIDER=$(PROVIDER) SLIDES=1-3,7,10-12 # analyse selected 1-based slide/frame groups"
	@echo "  make debug-frame DAY=$(DAY) DEBUG_FRAME=<obs-or-evidence-id> # analyse one raw screenshot and print the prompt/output"
	@echo "  make model-eval     # compare OpenAI models for weekly efficiency report quality"
	@echo "  make verify-mmp     # validate the repeated-task evidence-to-skill MMP gate"
	@echo "  make ui             # edit, generate, and download skill proposals in a local web UI"

dirs:
	@mkdir -p logs/ralf storage output "$(DEBUG_DIR)"

build: dirs
	@if [ -f package.json ]; then \
		$(NPM) run build --if-present; \
	else \
		echo "No package.json yet; skipping build until the Lucille app is scaffolded."; \
	fi

capture: build
	@if [ -f "$(CLI)" ]; then \
		echo "Capturing visible frames every $(CAPTURE_INTERVAL)s for DAY=$(DAY). Press Ctrl-C to stop."; \
		while true; do \
			$(NODE) "$(CLI)" capture once --day "$(DAY)" --ack-real-capture || exit $$?; \
			sleep "$(CAPTURE_INTERVAL)"; \
		done; \
	else \
		echo "Lucille CLI not found at $(CLI). Explicit one-frame capture is unavailable until scaffolded."; \
	fi

capture-permission: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" capture permission; \
	else \
		echo "Lucille CLI not found at $(CLI). Screen Recording permission check is unavailable until scaffolded."; \
	fi

capture-pause: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" capture pause; \
	else \
		echo "Lucille CLI not found at $(CLI); nothing to pause."; \
	fi

capture-resume: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" capture resume; \
	else \
		echo "Lucille CLI not found at $(CLI); nothing to resume."; \
	fi

capture-stop: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" capture stop; \
	else \
		echo "Lucille CLI not found at $(CLI); nothing to stop."; \
	fi

capture-once: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" capture once --day "$(DAY)" --ack-real-capture; \
	else \
		echo "Lucille CLI not found at $(CLI); capture-once is unavailable until scaffolded."; \
	fi

analyse: build
	@if [ -f "$(CLI)" ]; then \
		ARGS="analyse --day $(DAY) --provider $(PROVIDER)"; \
		if [ -n "$(MODEL)" ]; then \
			ARGS="$$ARGS --model $(MODEL)"; \
		fi; \
		if [ -n "$(ANALYSE_LIMIT)" ]; then \
			ARGS="$$ARGS --limit $(ANALYSE_LIMIT) --offset $(ANALYSE_OFFSET)"; \
		fi; \
		if [ "$(DELETE_RAW_MEDIA)" = "1" ]; then \
			ARGS="$$ARGS --delete-raw-media"; \
		fi; \
		if [ "$(DEDUPE)" = "0" ]; then \
			ARGS="$$ARGS --no-dedupe"; \
		fi; \
		if [ "$(OPENAI)" = "1" ]; then \
			ARGS="$$ARGS --openai --reasoning-effort $(REASONING_EFFORT)"; \
			if [ -n "$(OPENAI_MODEL)" ]; then \
				ARGS="$$ARGS --openai-model $(OPENAI_MODEL)"; \
			fi; \
		elif [ "$(OPENAI)" = "auto" ]; then \
			ARGS="$$ARGS --reasoning-effort $(REASONING_EFFORT)"; \
			if [ -n "$(OPENAI_MODEL)" ]; then \
				ARGS="$$ARGS --openai-model $(OPENAI_MODEL)"; \
			fi; \
		elif [ "$(OPENAI)" = "0" ]; then \
			ARGS="$$ARGS --no-openai"; \
		fi; \
		echo "$(NODE) $(CLI) $$ARGS"; \
		$(NODE) "$(CLI)" $$ARGS; \
	else \
		echo "Lucille CLI not found at $(CLI). Intended analysis: day=$(DAY), model=$${MODEL:-from .env}, openai=$(OPENAI), openai_model=$${OPENAI_MODEL:-from .env}."; \
	fi

debug-analysis: build
	@if [ -z "$(SLIDES)" ]; then \
		echo "Set SLIDES to one or more 1-based slide/frame groups, for example: make debug-analysis DAY=$(DAY) SLIDES=1-3,7,10-12"; \
		exit 2; \
	fi
	@if [ -f "$(CLI)" ]; then \
		ARGS="analyse --day $(DAY) --provider $(PROVIDER) --slides $(SLIDES) --debug-output $(DEBUG_DIR)/latest-debug-analysis.json"; \
		if [ -n "$(MODEL)" ]; then \
			ARGS="$$ARGS --model $(MODEL)"; \
		fi; \
		if [ "$(DELETE_RAW_MEDIA)" = "1" ]; then \
			ARGS="$$ARGS --delete-raw-media"; \
		fi; \
		if [ "$(DEDUPE)" = "0" ]; then \
			ARGS="$$ARGS --no-dedupe"; \
		fi; \
		if [ "$(OPENAI)" = "1" ]; then \
			ARGS="$$ARGS --openai --reasoning-effort $(REASONING_EFFORT)"; \
			if [ -n "$(OPENAI_MODEL)" ]; then \
				ARGS="$$ARGS --openai-model $(OPENAI_MODEL)"; \
			fi; \
		elif [ "$(OPENAI)" = "auto" ]; then \
			ARGS="$$ARGS --reasoning-effort $(REASONING_EFFORT)"; \
			if [ -n "$(OPENAI_MODEL)" ]; then \
				ARGS="$$ARGS --openai-model $(OPENAI_MODEL)"; \
			fi; \
		elif [ "$(OPENAI)" = "0" ]; then \
			ARGS="$$ARGS --no-openai"; \
		fi; \
		echo "$(NODE) $(CLI) $$ARGS"; \
		$(NODE) "$(CLI)" $$ARGS; \
	else \
		echo "Lucille CLI not found at $(CLI). Intended debug analysis: day=$(DAY), slides=$(SLIDES), model=$${MODEL:-from .env}, openai=$(OPENAI), openai_model=$${OPENAI_MODEL:-from .env}."; \
	fi

debug-frame: build
	@if [ -f "$(CLI)" ]; then \
		ARGS="debug-frame --day $(DAY) --offset $(DEBUG_OFFSET) --debug-output $(DEBUG_DIR)/latest-debug-frame.json"; \
		if [ -n "$(DEBUG_FRAME)" ]; then \
			ARGS="debug-frame --day $(DAY) --frame-id $(DEBUG_FRAME) --debug-output $(DEBUG_DIR)/latest-debug-frame.json"; \
		fi; \
		if [ -n "$(MODEL)" ]; then \
			ARGS="$$ARGS --model $(MODEL)"; \
		fi; \
		echo "Prompt source: src/analysis/ollamaProvider.mjs#buildOllamaPrompt"; \
		echo "$(NODE) $(CLI) $$ARGS"; \
		$(NODE) "$(CLI)" $$ARGS; \
	else \
		echo "Lucille CLI not found at $(CLI); single-frame prompt debugging is unavailable until scaffolded."; \
	fi

report: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" report --day "$(DAY)"; \
	else \
		echo "Lucille CLI not found at $(CLI); report generation is unavailable until scaffolded."; \
	fi

model-eval: build
	@if [ -f "$(CLI)" ]; then \
		ARGS="eval-models --day $(DAY) --reasoning-effort $(REASONING_EFFORT)"; \
		if [ -n "$(EVAL_MODELS)" ]; then \
			ARGS="$$ARGS --models $(EVAL_MODELS)"; \
		fi; \
		$(NODE) "$(CLI)" $$ARGS; \
	else \
		echo "Lucille CLI not found at $(CLI); model evaluation is unavailable until scaffolded."; \
	fi

export-skill: build
	@if [ -f "$(CLI)" ]; then \
		ARGS="export --day $(DAY)"; \
		if [ -n "$(PROPOSAL)" ]; then \
			ARGS="$$ARGS --proposal-id $(PROPOSAL)"; \
		fi; \
		if [ "$(APPROVE_EXPORT)" = "1" ]; then \
			ARGS="$$ARGS --approve-export"; \
		fi; \
		echo "$(NODE) $(CLI) $$ARGS"; \
		$(NODE) "$(CLI)" $$ARGS; \
	else \
		echo "Lucille CLI not found at $(CLI); skill export is unavailable until scaffolded."; \
	fi

ui: build
	@if [ -f "$(CLI)" ]; then \
		$(NODE) "$(CLI)" ui --day "$(DAY)" --port "$(UI_PORT)"; \
	else \
		echo "Lucille CLI not found at $(CLI); skill UI is unavailable until scaffolded."; \
	fi

dist-ui-recording: build
	@$(NODE) scripts/create-ui-recording-dist.mjs

recording-dist: dist-ui-recording

operator-smoke-preflight:
	@ARGS="--day $(DAY) --provider ollama --preflight"; \
	if [ -n "$(MODEL)" ]; then ARGS="$$ARGS --model $(MODEL)"; fi; \
	$(NODE) scripts/operator-smoke.mjs $$ARGS

operator-smoke:
	@ARGS="--day $(DAY) --provider ollama --capture-count $(OPERATOR_SMOKE_CAPTURE_COUNT) --capture-interval $(OPERATOR_SMOKE_CAPTURE_INTERVAL)"; \
	if [ -n "$(MODEL)" ]; then ARGS="$$ARGS --model $(MODEL)"; fi; \
	$(NODE) scripts/operator-smoke.mjs $$ARGS

operator-smoke-existing:
	@ARGS="--day $(DAY) --provider ollama --from-existing-evidence --capture-count $(OPERATOR_SMOKE_CAPTURE_COUNT) --capture-interval $(OPERATOR_SMOKE_CAPTURE_INTERVAL)"; \
	if [ -n "$(MODEL)" ]; then ARGS="$$ARGS --model $(MODEL)"; fi; \
	$(NODE) scripts/operator-smoke.mjs $$ARGS

verify-mmp: build
	@DAY="$(DAY)" $(NPM) run verify:mmp

status:
	@$(NODE) scripts/summarise-ralf-status.mjs

ralf: dirs
	@./scripts/run-ralf-loop.sh "$${ITERATIONS:-8}"

ralf-mmp: dirs
	@PROMPT_FILE=prompts/mmp-readiness-ralf.md ./scripts/run-ralf-loop.sh "$${ITERATIONS:-8}"

ralf-closeout: dirs
	@PROMPT_FILE=prompts/mmp-closeout-ralf.md ./scripts/run-ralf-loop.sh "$${ITERATIONS:-8}"
