import type { NextConfig } from "next";

// public/ files have no content hash, so Next.js serves them with max-age=0 and
// Cloudflare re-fetches every request through the tunnel. Browsers may keep them
// for an hour and the Cloudflare edge for a day; purge the Cloudflare cache after
// replacing one. /_next/static keeps Next's own immutable header.
const PUBLIC_ASSET_CACHE =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

const nextConfig: NextConfig = {
  // Linux VPS/Docker builds set BUILD_STANDALONE=1 to emit .next/standalone
  // (see DEPLOY_VPS.md). Off by default: the Windows host runs `next start`,
  // which warns under standalone, and Windows cannot run the bundle's pnpm
  // symlinks.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  async headers() {
    return [
      {
        // Static file extensions only, never the /api or /v1 surfaces.
        source:
          "/:path((?!api/|v1/|_next/).*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2))",
        headers: [{ key: "Cache-Control", value: PUBLIC_ASSET_CACHE }],
      },
    ];
  },
};

export default nextConfig;
