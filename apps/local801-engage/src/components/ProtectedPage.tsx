import { redirect } from "next/navigation";
import { can, type Permission } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";

export async function ProtectedPage({
  children,
  permission,
}: {
  children: React.ReactNode;
  permission?: Permission;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (permission && !can(user.role, permission)) redirect("/unauthorized");
  return <>{children}</>;
}
