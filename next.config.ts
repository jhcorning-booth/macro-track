import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root is this directory; without this Turbopack walks up and finds
  // an unrelated lockfile in the home directory.
  turbopack: { root: __dirname },
  // The floating dev badge lands on top of the tab bar at phone widths.
  devIndicators: false,
};

export default nextConfig;
