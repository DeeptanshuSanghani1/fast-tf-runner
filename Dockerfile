# ---- Base image with Terraform ----
# (Alpine-based official image, small & fast)
FROM hashicorp/terraform:1.9.0 AS runner

# Install minimal tools + Node for the HTTP server
RUN apk add --no-cache bash curl git ca-certificates nodejs npm tini

# Caches & mirrors
ENV TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache
RUN mkdir -p /cache/.terraform.d/plugin-cache /mirror /app /build

# --- Pre-warm the AWS provider into cache & mirror (fast init later) ---
# NOTE: Use a *multi-line* HCL block. The heredoc label is quoted to avoid shell expansion.
RUN cat > /build/main.tf <<'HCL'
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
provider "aws" {
  region = "us-east-1"
}
HCL \
 && terraform -chdir=/build init -backend=false -input=false -no-color \
 && mkdir -p /mirror/registry.terraform.io/hashicorp \
 && cp -r /build/.terraform/providers/registry.terraform.io/hashicorp/aws \
       /mirror/registry.terraform.io/hashicorp/aws \
 && rm -rf /build

# Tell terraform to use the local mirror (super fast, no network)
ENV TF_CLI_ARGS_init="-plugin-dir=/mirror"
# Keep cache mounted inside the container
ENV TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache

# ---- App code ----
WORKDIR /app
# install prod deps first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# now copy the rest of your app (server.js, routes, etc.)
COPY . .

# Non-root for Cloud Run best-practice
RUN adduser -D runner && chown -R runner:runner /app /cache /mirror
USER runner

# Cloud Run listens on $PORT
ENV PORT=8080
EXPOSE 8080

# Init-proc to reap zombies
ENTRYPOINT ["/sbin/tini","--"]

# Start your Node server (must listen on PORT)
CMD ["node","server.js"]
