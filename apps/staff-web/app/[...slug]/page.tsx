import { EmptyState, PageHeader } from "@dentalos/ui";
import { NAV } from "../../lib/nav";

export default async function Planned({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const href = `/${slug[0]}`;
  const item = NAV.find((n) => n.href === href);
  const title = item?.label ?? "Page not found";
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title={item ? `${title} is on the roadmap` : "We couldn't find that page"}
        description={
          item
            ? `This module is planned for ${item.milestone ?? "a later milestone"}.`
            : "Check the address or use the navigation."
        }
      />
    </>
  );
}
