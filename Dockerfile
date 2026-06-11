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

EXPOSE 3000

CMD ["npm", "run", "start"]
