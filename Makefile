# decision-router: escolhe o modelo certo para cada prompt (CLI, plugin do Claude Code, extension do Pi)
#
# `make` ou `make help` lista os alvos. Este Makefile é uma fachada: cada alvo
# delega pra ferramenta de verdade (bun, biome, tsc). Regra nova entra com
# `## descrição` na mesma linha pra aparecer no help.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --warn-undefined-variables --no-builtin-rules --no-print-directory
.DEFAULT_GOAL := help
.DELETE_ON_ERROR:

# ---------------------------------------------------------------------------
# Variáveis (?= permite sobrescrever: `make run ARGS="pick rename foo"`)
# ---------------------------------------------------------------------------

APP   ?= decision-router
ARGS  ?= --help
CASES ?= examples/claude-code-cases.jsonl

# Cores só quando stdout é um terminal (pipe e CI ficam limpos)
BOLD  :=
CYAN  :=
GREEN :=
RESET :=
ifneq ($(shell [ -t 1 ] && echo tty),)
  BOLD  := $(shell tput bold 2>/dev/null)
  CYAN  := $(shell tput setaf 6 2>/dev/null)
  GREEN := $(shell tput setaf 2 2>/dev/null)
  RESET := $(shell tput sgr0 2>/dev/null)
endif

##@ Geral

.PHONY: help
help: ## Lista os alvos disponíveis
	@awk 'BEGIN { FS = ":.*##"; printf "\n$(BOLD)$(APP)$(RESET)\n\nUso: make $(CYAN)<alvo>$(RESET)\n" } \
	  /^##@/ { printf "\n$(BOLD)%s$(RESET)\n", substr($$0, 5) } \
	  /^[a-zA-Z0-9_.\/-]+:.*?##/ { printf "  $(CYAN)%-18s$(RESET) %s\n", $$1, $$2 } \
	  END { printf "\n" }' $(MAKEFILE_LIST)

.PHONY: setup
setup: ## Instala dependências com bun
	@echo "$(GREEN)▸ setup$(RESET)"
	bun install --frozen-lockfile

##@ Desenvolvimento

.PHONY: run
run: build ## Roda o CLI construído no Node (ARGS="pick rename foo")
	@echo "$(GREEN)▸ run$(RESET)"
	node dist/cli.js $(ARGS)

.PHONY: eval
eval: build ## Compara Jev e heurística nos casos rotulados (precisa de chave TypeSafe)
	@echo "$(GREEN)▸ eval $(CASES)$(RESET)"
	node dist/cli.js eval $(CASES) --verbose

##@ Qualidade

.PHONY: fmt
fmt: ## Formata e aplica correções seguras do biome
	@echo "$(GREEN)▸ fmt$(RESET)"
	bunx biome check --write .

.PHONY: lint
lint: ## Biome e typecheck, sem modificar nada
	@echo "$(GREEN)▸ lint$(RESET)"
	bunx biome check .
	bunx tsc --noEmit

.PHONY: test
test: ## Roda os testes (sem rede, sem chave)
	@echo "$(GREEN)▸ test$(RESET)"
	env -u TYPESAFE_API_KEY bun test

.PHONY: smoke
smoke: build ## Roda o bundle no Node como o usuário roda, com pipe
	@echo "$(GREEN)▸ smoke$(RESET)"
	scripts/smoke.sh

.PHONY: check
check: lint test build smoke ## Tudo que o CI roda: lint, test, build, smoke
	@echo "$(GREEN)✓ check ok$(RESET)"

##@ Release

.PHONY: whoami
whoami: ## Mostra quem está autenticado no npm (E401 = sessão morta)
	@echo "$(GREEN)▸ whoami$(RESET)"
	npm whoami

.PHONY: publish
publish: ## Publica do local, só como plano B do Release Please (prepublishOnly roda o gate)
	@echo "$(GREEN)▸ publish$(RESET)"
	npm publish --access public

##@ Build

.PHONY: build
build: ## Empacota dist/ para Node e gera os .d.ts
	@echo "$(GREEN)▸ build$(RESET)"
	bun run build

.PHONY: pack
pack: build ## Mostra o que iria para o npm, sem publicar
	@echo "$(GREEN)▸ pack$(RESET)"
	npm pack --dry-run

.PHONY: clean
clean: ## Remove artefatos gerados
	@echo "$(GREEN)▸ clean$(RESET)"
	rm -rf dist *.tgz
