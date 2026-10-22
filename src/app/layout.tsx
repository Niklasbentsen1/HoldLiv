import type { ReactNode } from "react";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "./tokens.css";
import "./globals.css";

/** Signaturfarve: "violet", "lagune" eller "hindbaer". Farverne står i tokens.css. */
const BRAND = "violet";

export const metadata = { title: "HoldLiv", description: "Foreningsliv samlet ét sted" };
export const viewport = { themeColor: "#f4f4f1", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="da" data-brand={BRAND}>
      <body>{children}</body>
    </html>
  );
}
