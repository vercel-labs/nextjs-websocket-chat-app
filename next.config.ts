import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@vercel/functions` (and its `ws` dependency, used for the WebSocket
  // upgrade) and `ioredis` (the TCP Redis client behind the realtime stream
  // reader) rely on Node.js built-ins, so keep them out of the server bundle
  // and `require()` them at runtime.
  serverExternalPackages: ["@vercel/functions", "ws", "ioredis"],
};

export default nextConfig;
