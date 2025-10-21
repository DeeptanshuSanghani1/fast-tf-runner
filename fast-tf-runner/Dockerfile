# Fast Node base
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Terraform
ARG TF_VERSION=1.9.8
RUN curl -fsSL https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip -o /tmp/tf.zip \
 && unzip /tmp/tf.zip -d /usr/local/bin \
 && terraform version

# Pre-warm a provider mirror at build time (keeps runs <5s even on cold start)
RUN mkdir -p /mirror /cache/.terraform.d/plugin-cache /build && \
    printf '%s\n' \
'terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }' \
'provider "aws" { region = "us-east-1" }' > /build/main.tf && \
    TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache terraform -chdir=/build init -backend=false -input=false -no-color && \
    mkdir -p /mirror/registry.terraform.io/hashicorp && \
    cp -r /build/.terraform/providers/registry.terraform.io/hashicorp/aws /mirror/registry.terraform.io/hashicorp/aws && \
    rm -rf /build

# App
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev
COPY .terraformrc /home/node/.terraformrc
COPY server.js ./

# Non-root
USER node
ENV TF_PLUGIN_CACHE_DIR=/cache/.terraform.d/plugin-cache
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
