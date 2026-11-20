import { AcceptInvite } from "./accept-invite";

export const metadata = { title: "Accept invitation" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Target of the invitation link (`acceptPath` = /invite/accept?tenantId=…&token=…). */
export default async function AcceptInvitePage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  return <AcceptInvite tenantId={first(sp.tenantId)} token={first(sp.token)} />;
}
