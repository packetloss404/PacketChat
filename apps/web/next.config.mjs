/** @type {import('next').NextConfig} */
const nextConfig = {
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
