"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Henter siden igen med jævne mellemrum, mens fanen er synlig, så nye beskeder dukker op. */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector("textarea:focus")) router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
