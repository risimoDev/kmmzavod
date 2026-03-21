/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: "standalone", // Enable in production (requires symlink permission on Windows)
  images: {
    remotePatterns: [
      { protocol: "http",  hostname: "localhost"  },
      { protocol: "https", hostname: "*.minio.io" },
      { protocol: "https", hostname: "placehold.co" },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts", "framer-motion"],
  },
};

module.exports = nextConfig;
