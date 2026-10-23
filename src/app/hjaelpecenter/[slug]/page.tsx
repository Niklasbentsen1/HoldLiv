import Link from "next/link";
import { notFound } from "next/navigation";
import { AUDIENCES, findArticle } from "../../../lib/hjaelpeartikler";
import { HelpFrame } from "../../../components/HelpFrame";
import { PageHead } from "../../../components/ui";

export const dynamic = "force-dynamic";

export default async function Article({ params }: { params: Promise<{ slug: string }> }) {
  const a = findArticle((await params).slug);
  if (!a) notFound();
  const items = a.body.filter((l) => l.startsWith("- "));
  return (
    <HelpFrame>
      <PageHead back={{ href: "/hjaelpecenter", label: "Hjælpecenter" }} title={a.title} sub={a.audiences.map((x) => AUDIENCES[x]).join(" · ")} />
      {a.body.map((l, i) =>
        l.startsWith("- ") ? (i === a.body.findIndex((x) => x.startsWith("- ")) ? <ul key={i}>{items.map((x) => <li key={x}>{x.slice(2)}</li>)}</ul> : null) : <p key={i}>{l}</p>,
      )}
      {a.link && <p><Link href={a.link.href} className="primary">{a.link.label}</Link></p>}
      <p className="muted small">Hjalp det ikke? <Link href="/hjaelpecenter/kontakt">Skriv til HoldLiv-support</Link>.</p>
    </HelpFrame>
  );
}
