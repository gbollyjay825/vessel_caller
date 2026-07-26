SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PYTHON ?= python3.12
VENV ?= .venv
BACKEND_PY := $(VENV)/bin/python

.PHONY: help bootstrap services-up services-down backend-check backend-test frontend-check test build infra-test release-check

help:
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap: ## Install local backend and frontend dependencies
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --require-hashes --requirement backend/requirements/development.txt
	cd frontend && npm ci

services-up: ## Start local PostgreSQL and Redis
	docker compose up --detach --wait postgres redis

services-down: ## Stop local services without deleting data
	docker compose down

backend-check: ## Run Django deployment and migration checks
	$(BACKEND_PY) backend/manage.py check
	$(BACKEND_PY) backend/manage.py makemigrations --check --dry-run

backend-test: ## Run backend tests with coverage
	cd backend && ../$(BACKEND_PY) -m pytest

frontend-check: ## Lint, type-check, and test the React app
	cd frontend && npm run lint && npm run typecheck && npm run test:coverage

test: backend-check backend-test frontend-check ## Run all unit/integration checks

build: ## Build the frontend production bundle
	cd frontend && npm run build

infra-test: ## Validate infrastructure and release packaging
	deploy/scripts/validate-infra.sh
	tests/infra/test-release-scripts.sh

release-check: infra-test ## Verify release scripts and package metadata
