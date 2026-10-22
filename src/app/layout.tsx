import type { ReactNode } from "react";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "./tokens.css";
import "./globals.css";

export const metadata = { title: "HoldLiv", description: "Foreningsliv samlet ét sted" };
export const viewport = { themeColor: "#eceee7", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="da">
      <body>{children}</body>
    </html>
  );
}
