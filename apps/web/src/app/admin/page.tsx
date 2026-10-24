import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";

export default async function AdminIndex() {
  await requireAdmin();
  redirect("/admin/authz");
}
