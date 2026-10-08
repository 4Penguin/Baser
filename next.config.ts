import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the Base44 preview origin to access Next.js dev assets/HMR.
  // Only active in the Base44 sandbox; no effect in normal local dev.
  ...(process.env.BASE44_PREVIEW_MODE === "1" && process.env.BASE44_PUBLIC_HOST_SUFFIX
    ? {
        allowedDevOrigins: ["3000-" + process.env.BASE44_PUBLIC_HOST_SUFFIX],
      }
    : {}),
};

export default nextConfig;
