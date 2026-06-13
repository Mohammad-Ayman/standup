# Standup — single image for both processes.
#
# The web service uses the default CMD (`npm run start`).
# The worker service in docker-compose.yml overrides the command with
# `npm run worker` (and the migrate service with `npm run db:migrate`).
FROM node:22-slim

# git + CA certs are required by the executor (ephemeral clone -> branch -> PR).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

# Claude Code refuses --dangerously-skip-permissions under root, which the
# executor needs (permissionMode: bypassPermissions). Run as the unprivileged
# `node` user that the base image ships. Give it ownership of the app tree and
# a writable HOME (npm/tsx/Next caches, Claude Code config).
ENV HOME=/home/node
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
