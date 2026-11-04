#!/bin/sh
set -eu
: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${SERVICE_ACCOUNT:?set SERVICE_ACCOUNT}"
: "${SQL_INSTANCE:?set SQL_INSTANCE (project:region:instance)}"
: "${PUBLIC_BASE_URL:?set the final HTTPS origin}"
vpn_service_name=${SERVICE_NAME:-vpn}
vpn_secret_prefix=${SECRET_PREFIX:-vpn}
# Existing Secret Manager versions must contain real credentials. This script does not create or print them.
gcloud run deploy "$vpn_service_name" \
  --project "$PROJECT_ID" --region "$REGION" --source . \
  --service-account "$SERVICE_ACCOUNT" --port 8080 \
  --memory 512Mi --cpu 1 --concurrency 40 --min-instances 0 --max-instances 3 \
  --add-cloudsql-instances "$SQL_INSTANCE" \
  --set-env-vars "NODE_ENV=production,PUBLIC_BASE_URL=$PUBLIC_BASE_URL" \
  --set-secrets "DATABASE_URL=$vpn_secret_prefix-database-url:latest,DATA_KEY=$vpn_secret_prefix-data-key:latest,ADMIN_PASSWORD=$vpn_secret_prefix-admin-password:latest,JOB_TOKEN=$vpn_secret_prefix-job-token:latest" \
  --allow-unauthenticated
# Public HTTP ingress is needed for employee OAuth and gateway tokens; application APIs enforce their own authentication.
