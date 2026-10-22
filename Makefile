.PHONY: help dev dev-web test typecheck build deploy

export WRANGLER_SEND_METRICS := false

help:
	@printf '%s\n' 'dev        Build and serve page + Functions at https://127.0.0.1:8788' 'dev-web    Vite hot reload (browser only; no Functions)' 'test       Run hermetic unit tests' 'typecheck  Check browser, Functions/tests, and build configs' 'build      Bundle browser and Functions locally' 'deploy     Verify, build, and deploy to Pages (requires approval and PAGES_PROJECT=<project>)'

dev: build
	pnpm run dev

dev-web:
	pnpm run dev:web

test:
	pnpm test

typecheck:
	pnpm run typecheck

build:
	pnpm run build

# A deploy must name its project. The root wrangler.jsonc names `pocket-radio-web`, so a bare `wrangler pages deploy` would
# target (or create) that project instead of staging. Example: make deploy PAGES_PROJECT=pocket-radio-web-m1-staging
deploy:
	@test -n "$(PAGES_PROJECT)" || { echo 'Set PAGES_PROJECT, e.g. make deploy PAGES_PROJECT=pocket-radio-web-m1-staging'; exit 1; }
	@$(MAKE) test typecheck build
	PAGES_PROJECT="$(PAGES_PROJECT)" pnpm run deploy
