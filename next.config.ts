import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle in .next/standalone so a VPS deploy
  // ships without node_modules. No effect on `next dev`.
  output: "standalone",
};

export default nextConfig;
