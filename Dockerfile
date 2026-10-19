FROM node:22-bookworm-slim AS build
RUN npm install --global pnpm@11.19.0
WORKDIR /workspace
COPY . .
ENV VITE_API_URL=/api
RUN pnpm install --frozen-lockfile && pnpm build
RUN pnpm --filter @ai-chat-eval/api deploy --prod /out/api && pnpm --filter @ai-chat-eval/worker deploy --prod /out/worker

FROM node:22-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm AS api
RUN apt-get update && apt-get install --no-install-recommends -y libstdc++6 libatomic1 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app && useradd --uid 1000 --gid app --create-home app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build --chown=app:app /out/api/ ./
COPY --from=build --chown=app:app /workspace/packages/python/core/src/ /app/python/
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000 DIAGNOSIS_PYTHON_EXECUTABLE=python3 DIAGNOSIS_PYTHONPATH=/app/python PYTHONDONTWRITEBYTECODE=1
USER app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=6s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
COPY --from=build --chown=node:node /out/worker/ ./
ENV NODE_ENV=production WORKER_HEALTH_HOST=0.0.0.0 WORKER_HEALTH_PORT=4101
USER node
EXPOSE 4101
HEALTHCHECK --interval=15s --timeout=6s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4101/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY --from=build /workspace/apps/web/dist/ /usr/share/nginx/html/
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1
