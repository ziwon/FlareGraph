default:
    @just --list

install:
    pnpm install

build:
    pnpm -r build

test:
    pnpm -r test

typecheck:
    pnpm -r typecheck

dev-worker:
    pnpm --filter @flaregraph/worker dev

deploy:
    pnpm --filter @flaregraph/worker deploy

migrate-local db="flaregraph.sqlite":
    pnpm --filter @flaregraph/cli exec flaregraph init --db {{db}}

migrate-d1:
    cd apps/worker && pnpm exec wrangler d1 migrations apply flaregraph --remote

# After enabling R2 in the dashboard (and re-running `wrangler login` for the r2 scope):
provision-r2:
    cd apps/worker && pnpm exec wrangler r2 bucket create flaregraph-vault
    cd apps/worker && pnpm exec wrangler r2 bucket notification create flaregraph-vault \
        --event-type object-create --event-type object-delete --queue flaregraph-index
    cd apps/worker && pnpm exec wrangler deploy
