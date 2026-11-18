# The Future Self server as a container, for Google Cloud Run (see docs/DEPLOYMENT.md).
# Cloud Build builds it remotely during `gcloud run deploy --source .`; Docker is not needed locally.
# Node 26 matches the version the test suite runs on.
FROM node:26-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
# Run without root rights. Cloud Run supplies PORT (8080); keys and settings come from its environment.
USER node
EXPOSE 8080
CMD ["node", "--import=./lib/load-secrets.mjs", "server.mjs"]
