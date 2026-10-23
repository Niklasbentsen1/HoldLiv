import type { ReactNode } from "react";
import { Shell } from "./Shell";
import { getSession } from "../lib/session";

/** Hjælpecenteret kan læses uden login. Med login vises det i appens ramme. */
export async function HelpFrame({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session) return <Shell active="/hjaelp" ctx={session.ctx}>{children}</Shell>;
  return <main className="stack" style={{ maxWidth: 720, margin: "48px auto", padding: "0 16px" }}>{children}</main>;
}
