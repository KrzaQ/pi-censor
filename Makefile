.PHONY: help install test lint run clean
.DEFAULT_GOAL := help

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

clean: ## Remove installed dependencies
	rm -rf node_modules
