import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/page-header";
import { listUsers } from "@/lib/users";
import { UsersList } from "./users-list";

export const dynamic = "force-dynamic";

/**
 * Who can sign in.
 *
 * Exists so the activity log has more than one name to give: with a single
 * shared account every line reads "Admin", and "who sent this reply" still has
 * no answer.
 */
export default async function UsersPage() {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;

  // Members have no business reading the roster of who has access.
  if (role !== "ADMIN") redirect("/");

  const users = await listUsers();
  const admins = users.filter((u) => u.role === "ADMIN").length;

  return (
    <>
      <PageHeader
        title="Users"
        description={
          users.length === 1
            ? "One account — every line in Activity will say the same name until there are more."
            : `${users.length} accounts, ${admins} of them admin.`
        }
      />
      <div className="max-w-3xl p-8">
        <UsersList users={users} currentUserId={session?.user?.id ?? ""} />
      </div>
    </>
  );
}
