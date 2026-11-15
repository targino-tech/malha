# syntax=docker/dockerfile:1
# Imagens de produção do Malha: `--target web` (Next.js) e `--target worker` (outbox, regras e retenção).
# A base é fixada por digest; atualize junto com .node-version.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm na versão e no hash do packageManager do package.json: o corepack confere a integridade do download.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && corepack install
# node_modules plano: o build standalone do Next copia dependências sem links simbólicos do pnpm.
RUN echo 'nodeLinker: hoisted' >> pnpm-workspace.yaml && pnpm install --frozen-lockfile
COPY . .
RUN MALHA_MODE=demo MALHA_STANDALONE=1 pnpm build && pnpm bundle:worker

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Migrações SQL lidas pela CLI de banco e pelo demo.
COPY --from=build /app/packages/db/*.sql ./packages/db/

FROM base AS web
ENV HOSTNAME=0.0.0.0 PORT=3000 MALHA_SERVICE=web
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# server.js roda a partir de apps/web; o demo lê as migrações relativas a esse diretório.
COPY --from=build /app/packages/db/*.sql ./apps/web/packages/db/
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM base AS worker
ENV MALHA_SERVICE=worker
COPY --from=build /app/dist/worker.js /app/dist/manage.js ./dist/
USER node
# A tarefa de migração usa a mesma imagem: command = ["node", "dist/manage.js", "migrate"].
CMD ["node", "dist/worker.js"]
