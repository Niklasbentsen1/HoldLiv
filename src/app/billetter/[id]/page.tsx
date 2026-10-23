import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicTicketEvent } from "../../../services";
import { db } from "../../../lib/db";
import { kr } from "../../../lib/money";
import { when } from "../../../lib/format";
import { Bare } from "../../../components/Shell";
import { buyTicketsAction } from "../../actions";
import { BuyForm } from "./BuyForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const e = await getPublicTicketEvent(db, (await params).id);
  return { title: e ? `${e.name} · ${e.clubName}` : "HoldLiv", robots: { index: false, follow: false } };
}

/** Den åbne side, hvor man køber billetter til et arrangement. Ingen login. */
export default async function Tickets({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await getPublicTicketEvent(db, id);
  if (!e) notFound();
  return (
    <Bare>
      <section className="card stack">
        <span className="muted small">{e.clubName}</span>
        <h1 className="flush">{e.name}</h1>
        <span>
          {when(e.startsAt)}
          {e.location ? ` · ${e.location}` : ""}
        </span>
        {e.description && <p className="chat-text">{e.description}</p>}
        <p className="big">{e.priceOre === 0 ? "Gratis" : kr(e.priceOre)}</p>
        {e.cancelled && <p className="error">Arrangementet er aflyst.</p>}
        {!e.cancelled && !e.open && <p className="error">{e.remaining === 0 ? "Der er udsolgt." : "Salget er lukket."}</p>}
        {e.open && e.remaining !== null && <span className="muted small">{e.remaining} billetter tilbage</span>}
      </section>
      {e.open && <BuyForm maxPerOrder={e.maxPerOrder} remaining={e.remaining} priceLabel={e.priceOre === 0 ? "gratis" : kr(e.priceOre)} action={buyTicketsAction.bind(null, e.id)} />}
      <p className="muted small">
        <Link href={`/klub/${e.clubSlug}`}>Til {e.clubName}</Link>
      </p>
    </Bare>
  );
}
