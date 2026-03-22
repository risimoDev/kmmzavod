/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
  images: {
    remotePatterns: [
      { protocol: "http",  hostname: "localhost"  },
      { protocol: "https", hostname: "*.minio.io" },
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: process.env.MINIO_PUBLIC_HOST ?? "minio" },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts", "framer-motion"],
  },
};

module.exports = nextConfig;
