FROM node:20-bookworm-slim

ARG SUPABASE_CLI_VERSION=2.79.0
ARG PG_MAJOR=17
ARG TARGETARCH

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gnupg \
    gzip \
  && rm -rf /var/lib/apt/lists/*

RUN install -d /usr/share/keyrings \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "${arch}" in \
    amd64|arm64) cli_arch="${arch}" ;; \
    *) echo "Unsupported architecture for Supabase CLI: ${arch}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/supabase.deb \
    "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_${cli_arch}.deb" \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/supabase.deb \
  && supabase --version \
  && rm -f /tmp/supabase.deb \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY workers ./workers

EXPOSE 8080

CMD ["node", "workers/uk_aq_supabase_db_dump_backup_service/server.mjs"]
