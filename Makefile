.PHONY: help dev dev-web test typecheck build deploy

export WRANGLER_SEND_METRICS := false

help:
	@printf '%s\n' 'dev        Build and serve page + Functions at http://127.0.0.1:8788' 'dev-web    Vite hot reload (browser only; no Functions)' 'test       Run hermetic unit tests' 'typecheck  Check browser, Functions/tests, and build configs' 'build      Bundle browser and Functions locally' 'deploy     Verify, build, and deploy to Pages (requires approval)'

dev: build
	npm run dev

dev-web:
	npm run dev:web

test:
	npm test

typecheck:
	npm run typecheck

build:
	npm run build

deploy: test typecheck build
	npm run deploy
