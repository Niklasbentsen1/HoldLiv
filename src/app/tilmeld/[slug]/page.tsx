import { notFound } from "next/navigation";
import { getSignupInfo } from "../../../services";
import { db } from "../../../lib/db";
import { Bare } from "../../../components/Shell";
import { submitSignupAction } from "../../actions";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Meld dig ind · HoldLiv" };

export default async function Signup({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const info = await getSignupInfo(db, slug);
  if (!info) notFound();
  return (
    <Bare>
      <SignupForm info={{ clubName: info.clubName, minAge: info.minAge, maxAge: info.maxAge, terms: info.terms, teams: info.teams }} action={submitSignupAction.bind(null, slug)} />
    </Bare>
  );
}
