import type { NextConfig } from "next";

const config: NextConfig = {
  // Medlemsimport sender hele CSV-filen (op til 2 MB) som en server action.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
};

export default config;
