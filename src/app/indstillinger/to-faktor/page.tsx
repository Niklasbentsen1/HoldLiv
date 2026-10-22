import { redirect } from "next/navigation";
import { mfaStatus } from "../../../auth/mfa";
import { db } from "../../../lib/db";
import { getSession } from "../../../lib/session";
import { Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { MfaSetup } from "./MfaSetup";

export const dynamic = "force-dynamic";

export default async function MfaPage() {
  const session = await getSession({ allowMfaSetup: true });
  if (!session) redirect("/login?next=/indstillinger/to-faktor");
  const status = await mfaStatus(db, session.ctx.userId);
  return (
    <Shell active="/indstillinger" ctx={session.ctx}>
      <PageHead
        title="To-faktor"
        sub="Et ekstra trin ved login, så ingen kan komme ind på din konto med kun din e-mail. Kræves for foreningens admin og kasserer."
      />
      {status.required && !status.enabled && (
        <p className="pill">Som admin eller kasserer skal du slå to-faktor til, før du kan bruge HoldLiv.</p>
      )}
      <MfaSetup enabled={status.enabled} required={status.required} recoveryLeft={status.recoveryLeft} />
    </Shell>
  );
}
