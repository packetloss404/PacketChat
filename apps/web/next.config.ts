import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@packetchat/auth",
    "@packetchat/config",
    "@packetchat/contracts",
    "@packetchat/db",
    "@packetchat/files",
    "@packetchat/jobs",
    "@packetchat/observability",
    "@packetchat/providers"
  ]
};

export default nextConfig;
