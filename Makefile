.PHONY: up web-up web-debug web-logs web-ps down logs ps api web research lint check-model

ifneq (,$(wildcard .env))
include .env
export
endif

check-model:
	test -f "models/$${LLAMA_MODEL:-Qwen3.6-35B-A3B-UD-IQ4_NL_XL.gguf}" || (echo "GGUF model not found under ./models. Set LLAMA_MODEL in .env."; exit 1)

up: check-model
	docker compose --profile gpu --env-file .env up --build

web-up:
	docker compose --env-file .env up --build --force-recreate web

web-debug:
	docker compose ps -a web
	docker compose logs --tail=200 web

web-logs:
	docker compose logs -f web

web-ps:
	docker compose ps web

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

api:
	cd apps/api && npm run dev

web:
	cd apps/web && npm run dev

research:
	cd services/research && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

lint:
	cd apps/api && npm run typecheck
	cd apps/web && npm run typecheck
	cd services/research && python3 -m compileall app
