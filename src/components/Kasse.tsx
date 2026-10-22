import Link from "next/link";
import type { ReactNode } from "react";
import type { AccessContext } from "../auth/permissions";
import { listFinanceClubs } from "../services";
import { db } from "../lib/db";
import { Shell } from "./Shell";
import { Crest, PageHead } from "./ui";

const TABS = [
  { path: "", label: "Overblik" },
  { path: "/medlemmer", label: "Medlemmer" },
  { path: "/kontingenter", label: "Kontingenter" },
  { path: "/opkraevninger", label: "Opkrævninger" },
];

/** Foreningen kassen viser: den valgte i ?klub=, ellers den første. null hvis login'et ikke er kasserer/admin. */
export async function pickFinanceClub(ctx: AccessContext, klub?: string) {
  const clubs = await listFinanceClubs(db, ctx);
  return { clubs, club: clubs.find((c) => c.id === klub) ?? clubs[0] ?? null };
}

export function KasseShell({
  ctx,
  clubs,
  club,
  tab,
  children,
}: {
  ctx: AccessContext;
  clubs: { id: string; name: string }[];
  club: { id: string; name: string };
  tab: string;
  children: ReactNode;
}) {
  const q = `?klub=${club.id}`;
  return (
    <Shell ctx={ctx} active="/kasse">
      <PageHead kicker={<><Crest name={club.name} size={22} /> {club.name}</>} title="Kasse" />
      {clubs.length > 1 && (
        <p className="small">
          Andre foreninger:{" "}
          {clubs
            .filter((c) => c.id !== club.id)
            .map((c) => (
              <Link key={c.id} href={`/kasse${tab}?klub=${c.id}`}>
                {c.name}
              </Link>
            ))}
        </p>
      )}
      <nav className="seg subnav">
        {TABS.map((t) => (
          <Link key={t.path} href={`/kasse${t.path}${q}`} className={t.path === tab ? "on" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </Shell>
  );
}

export const NoAccess = ({ ctx }: { ctx: AccessContext }) => (
  <Shell ctx={ctx}>Kun foreningens kasserer og administratorer har adgang her.</Shell>
);

export const CHARGE_STATUS = {
  open: "Ikke betalt",
  paid: "Betalt",
  refunded: "Refunderet",
  cancelled: "Annulleret",
} as const;

export function ChargeTag({ status, overdue }: { status: keyof typeof CHARGE_STATUS; overdue?: boolean }) {
  const cls = overdue ? "overdue" : status;
  return <span className={`tag ${cls}`}>{overdue ? "Forfalden" : CHARGE_STATUS[status]}</span>;
}
