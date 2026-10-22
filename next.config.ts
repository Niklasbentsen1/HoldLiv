import type { NextConfig } from "next";

const config: NextConfig = {
  // Medlemsimport sender hele CSV-filen (op til 2 MB) og udlæg et kvitteringsfoto (op til 6 MB) som en server action.
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
};

export default config;
