# syntax=docker/dockerfile:1.6
#test
# --- Base runtime with Terraform installed -----------------------------------
FROM node:20-bullseye-slim AS runtime

ARG TF_VERSION=1.13.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip bash coreutils tar gzip \
 && rm -rf /var/lib/apt/lists/*

# Install Terraform
RUN curl -fsSL https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip \
 | busybox unzip -p - > /usr/local/bin/terraform \
 && chmod +x /usr/local/bin/terraform \
 && terraform -version

# Terraform CLI config: prefer filesystem mirror, fallback to direct
RUN mkdir -p /etc/terraform.d /mirror /cache/.terraform.d/plugin-cache
RUN printf '%s\n' \
'provider_installation {' \
'  filesystem_mirror {' \
'    path    = "/mirror"' \
'    include = ["hashicorp/*"]' \
'  }' \
'  direct {' \
'    exclude = ["hashicorp/*"]' \
'  }' \
'}' > /etc/terraform.d/terraform.rc
ENV TF_CLI_CONFIG_FILE=/etc/terraform.d/terraform.rc
ENV TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache

# --- Warm provider cache (AWS) to speed up init/validate ----------------------
RUN set -e \
 && mkdir -p /build \
 && cat >/build/main.tf <<'HCL'
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
HCL
 && TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache \
    terraform -chdir=/build init -backend=false -input=false -no-color \
 && mkdir -p /mirror/registry.terraform.io/hashicorp \
 && cp -r /build/.terraform/providers/registry.terraform.io/hashicorp/aws \
       /mirror/registry.terraform.io/hashicorp/aws \
 && rm -rf /build

# --- App layer (Node). Adjust if you use Go/Python/etc. ----------------------
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Non-root user for Cloud Run
RUN useradd -m -u 10001 appuser \
 && chown -R appuser:appuser /app /mirror /cache /etc/terraform.d
USER appuser

ENV PORT=8080
EXPOSE 8080
VOLUME ["/cache"]  # keep plugin cache warm across revisions

# Basic healthcheck (expects /health endpoint; adjust if needed)
HEALTHCHECK CMD node -e 'require("http").get("http://127.0.0.1:"+process.env.PORT+"/health", r => process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'

# Start your server (must listen on $PORT for Cloud Run)
CMD ["npm","start"]
