import { aiServiceStatus } from "../../services";
import { db } from "../../lib/db";
import { getAssistant } from "../../lib/memberAssistant";
import { requireSession } from "../../lib/session";
import { Shell } from "../../components/Shell";
import { PageHead } from "../../components/ui";
import { saveConsent } from "../actions";
import { HelpBox } from "./HelpBox";

export const dynamic = "force-dynamic";

export default async function Help() {
  const { ctx } = await requireSession("/hjaelp");
  const status = await aiServiceStatus(db, ctx, getAssistant());
  return (
    <Shell active="/hjaelp" ctx={ctx}>
      <PageHead title="Hjælp" sub="Få svar om dine aktiviteter og betalinger." />
      {!status.available ? (
        <p className="muted">Foreningen har ikke slået AI-hjælp til. Skriv til foreningen, hvis du har et spørgsmål.</p>
      ) : status.needsConsent ? (
        <form action={saveConsent} className="card stack" style={{ maxWidth: 560 }}>
          <input type="hidden" name="profileId" value={ctx.profileId} />
          <input type="hidden" name="kind" value="ai_service" />
          <input type="hidden" name="granted" value="1" />
          <p>
            For at svare sendes dine og dine børns aktiviteter og betalinger (uden navne) til en AI-udbyder. Du kan trække samtykket tilbage under Privatliv.
          </p>
          <div>
            <button className="primary">Giv samtykke</button>
          </div>
        </form>
      ) : (
        <div style={{ maxWidth: 560 }}>
          <HelpBox />
        </div>
      )}
    </Shell>
  );
}
