import type { NextConfig } from "next";

// Static export: the page has no data fetching, so it can be served from any
// file host. Set NEXT_PUBLIC_BASE_PATH when it lives under a sub-path (e.g.
// "/vellum" on GitHub Pages).
const config: NextConfig = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};

export default config;
