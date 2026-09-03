import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // react-leaflet double-mounts its map instance under Strict Mode's
  // dev-only effect double-invocation, which crashes with "Map container
  // is already initialized" -- production builds never run Strict Mode,
  // which is why this only ever shows up live in `next dev`, not in any
  // `next build` verification.
  reactStrictMode: false,
  // Pins the workspace root to this app instead of Next inferring it from
  // the nearest lockfile up the tree (D:\NETRA\package-lock.json) -- without
  // this, file tracing scans the whole monorepo-shaped D:\NETRA directory
  // (sibling apps' node_modules, Python venvs, ML model files, git objects)
  // instead of just this app, which is real, avoidable dev-server overhead.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
