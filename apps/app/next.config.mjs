import "./src/env.mjs";
import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@v1/ui", "@v1/backend", "@v1/analytics", "@v1/logger"],
};

// Only wrap when a DSN is actually configured.
//
// withSentryConfig injects the SDK into every client bundle whether or not it
// can report anything, and production builds here set NEXT_PUBLIC_SENTRY_DSN
// to an empty string (deploy/05-build-apps.sh). Measured on the deployed build:
// 317KB raw / 93KB gzip, 31% of the /chat bundle, downloaded, parsed and
// executed for nothing. The sentry.*.config.ts files and instrumentation.ts are
// deliberately left untouched, so setting a DSN restores the previous behaviour
// exactly.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
    silent: !process.env.CI,
    telemetry: false,
    widenClientFileUpload: true,
    hideSourceMaps: true,
    disableLogger: true,
    tunnelRoute: "/monitoring",
    })
  : nextConfig;
