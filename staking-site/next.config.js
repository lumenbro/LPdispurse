/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["@stellar/stellar-sdk"],
  },
};

module.exports = nextConfig;
