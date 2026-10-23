import type { NextConfig } from "next";

const config: NextConfig = {
  // Medlemsimport sender hele CSV-filen (op til 2 MB) og udlæg et kvitteringsfoto (op til 6 MB) som en server action. Dokumentarkivet tillader 10 MB pr. fil, så grænsen er 11 MB med plads til formularen.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
};

export default config;
