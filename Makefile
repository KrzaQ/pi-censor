.PHONY: help install test lint run deploy clean
.DEFAULT_GOAL := help

AGENT_DIR ?= $(or $(PI_CODING_AGENT_DIR),$(HOME)/.pi/agent)
DEPLOY_DIR ?= $(AGENT_DIR)/extensions/pi-censor

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort -t: -k1,1 | \
		awk 'BEGIN {FS = ":.*?## "; w = 12} { k[NR] = $$1; v[NR] = $$2; if (length($$1) > w) w = length($$1) } \
		     END { for (i = 1; i <= NR; i++) printf "  \033[36m%-*s\033[0m  %s\n", w, k[i], v[i] }'

install: ## Install dependencies
	bun install

test: install ## Run the tests
	bun test

lint: install ## Check the types
	bun run lint

run: install ## Start pi with pi-censor loaded for this session
	pi -e .

# A copy, not a link: a session in this repo must not change the live extension.
# The temp directory stays out of extensions/, because pi would load it from there.
deploy: ## Copy pi-censor to DEPLOY_DIR (default ~/.pi/agent/extensions/pi-censor)
	@set -e; \
	mkdir -p "$(dir $(DEPLOY_DIR))"; \
	tmp=$$(mktemp -d "$(AGENT_DIR)/.pi-censor-deploy.XXXXXX"); \
	trap 'rm -rf "$$tmp"' EXIT; \
	cp -R index.ts src "$$tmp/"; \
	chmod 755 "$$tmp"; \
	rm -rf "$(DEPLOY_DIR)"; \
	mv "$$tmp" "$(DEPLOY_DIR)"; \
	echo "pi-censor deployed to $(DEPLOY_DIR)"

clean: ## Remove installed dependencies
	rm -rf node_modules
