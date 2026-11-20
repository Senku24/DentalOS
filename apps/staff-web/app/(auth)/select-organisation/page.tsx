import { safeReturnTo } from "../../../lib/auth/return-to";
import { SelectOrganisation } from "./select-organisation";

export const metadata = { title: "Choose organisation" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function SelectOrganisationPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.returnTo) ? sp.returnTo[0] : sp.returnTo;
  return <SelectOrganisation returnTo={safeReturnTo(raw)} />;
}
