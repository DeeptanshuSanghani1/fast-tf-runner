# ---- Terraform base ----
FROM hashicorp/terraform:1.9.0

# Small utilities (and tini if you’ll run a server later)
RUN apk add --no-cache bash curl git ca-certificates tini

# Cache & mirror locations
ENV TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache
RUN mkdir -p /cache/.terraform.d/plugin-cache /mirror /build /app

# Write a valid multi-line HCL file and pre-warm the AWS provider
RUN set -eux; \
  printf '%s\n' \
  'terraform {' \
  '  required_providers {' \
  '    aws = {' \
  '      source  = "hashicorp/aws"' \
  '      version = "~> 5.0"' \
  '    }' \
  '  }' \
  '}' \
  'provider "aws" {' \
  '  region = "us-east-1"' \
  '}' \
  > /build/main.tf; \
  TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache terraform -chdir=/build init -backend=false -input=false -no-color; \
  mkdir -p /mirror/registry.terraform.io/hashicorp; \
  cp -r /build/.terraform/providers/registry.terraform.io/hashicorp/aws /mirror/registry.terraform.io/hashicorp/aws; \
  rm -rf /build

# Use the local mirror so `terraform init` is instant
FROM node:20-alpine
WORKDIR /app

# bring terraform binary + local mirror from previous stage
COPY --from=tf /bin/terraform /usr/local/bin/terraform
COPY --from=tf /mirror /mirror
ENV TF_CLI_ARGS_init="-plugin-dir=/mirror"

# app deps + sources
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .

# Cloud Run requires listening on PORT
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]