import Link from "next/link";
import { onboardingSteps } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { ErrorBox, Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";

export const dynamic = "force-dynamic";

export default async function GetStarted({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/kom-i-gang?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const steps = await onboardingSteps(db, ctx, klub);
  const done = steps.filter((s) => s.done).length;
  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead back={{ href: "/forening", label: "Forening" }} title="Kom i gang" sub={`${done} af ${steps.length} trin er klaret. Du kan springe over og vende tilbage, når det passer.`} />
      <ErrorBox message={fejl} />
      <ol className="stack" style={{ listStyle: "none", padding: 0 }}>
        {steps.map((s, i) => (
          <li key={s.key} className="card row" style={{ gap: 16, alignItems: "center" }}>
            <strong aria-hidden>{s.done ? "✓" : i + 1}</strong>
            <span className="grow">
              <strong className="block">{s.title}</strong>
              <span className="muted small">{s.text}</span>
            </span>
            <Link href={s.href} className={s.done ? "muted small" : "primary"}>{s.done ? "Se igen" : "Start"}</Link>
          </li>
        ))}
      </ol>
    </Shell>
  );
}
