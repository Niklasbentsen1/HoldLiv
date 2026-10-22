import Link from "next/link";
import { requireSession } from "../../../lib/session";
import { Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { ImportBox } from "./ImportBox";

export const dynamic = "force-dynamic";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ klub?: string }> }) {
  const { klub } = await searchParams;
  const { ctx } = await requireSession(`/forening/import?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer kan importere medlemmer.</Shell>;
  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead title="Importér medlemmer" sub="Flyt medlemmerne fra Excel, Klubmodul eller Holdsport. Du ser, hvad der vil ske, før noget gemmes." />
      <p className="muted small">
        Gem listen som CSV (i Excel: Gem som, CSV). Kolonner genkendes på overskriften: fornavn, efternavn, fødselsdato, e-mail, telefon, hold og forælder. Andre kolonner bliver til egne felter.
        Står et hold ikke i foreningen, oprettes det. Eksisterende medlemmer overskrives aldrig. <Link href={`/kasse/medlemmer?klub=${klub}`}>Til medlemslisten (kan hentes som CSV)</Link>
      </p>
      <ImportBox clubId={klub} />
    </Shell>
  );
}
