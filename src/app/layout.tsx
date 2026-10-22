import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "HoldLiv", description: "Foreningsliv samlet ét sted" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="da">
      <body>{children}</body>
    </html>
  );
}
