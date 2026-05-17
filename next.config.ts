import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  compress: true,
  async rewrites() {
    return [
      { source: "/", destination: "/cerebro.html" },
    ];
  },
  async headers() {
    return [
      {
        // Cache the static SPA shell aggressively — it only changes on deploy.
        source: "/cerebro.html",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Rewrite "/" → cerebro.html, so apply the same cache there too.
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
