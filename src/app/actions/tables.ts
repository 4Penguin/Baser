"use server";

import { revalidatePath } from "next/cache";

import { requireCurrentRestaurant } from "@/lib/restaurant";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type TableActionState = { error: string | null };

export async function addTable(
  _prevState: TableActionState,
  formData: FormData,
): Promise<TableActionState> {
  const branchId = String(formData.get("branchId") ?? "");
  const label = String(formData.get("label") ?? "").trim();

  if (!branchId || !label) {
    return { error: "Branch and table label are required." };
  }

  await requireCurrentRestaurant();
  const supabase = await createClient();

  const { error } = await supabase.from("restaurant_tables").insert({ branch_id: branchId, label });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/dashboard/tables");
  return { error: null };
}

/**
 * Dashboard override: reset an abandoned or stuck table. Closes any active
 * session and returns the table to "available". All historical data is
 * preserved — only the session status and table status change.
 */
export async function resetTable(tableId: string): Promise<TableActionState> {
  const restaurant = await requireCurrentRestaurant();
  const admin = createAdminClient();

  // Verify table belongs to this restaurant.
  const { data: table } = await admin
    .from("restaurant_tables")
    .select("id, branches!inner(restaurant_id)")
    .eq("id", tableId)
    .eq("branches.restaurant_id", restaurant.restaurantId)
    .maybeSingle();

  if (!table) return { error: "Table not found." };

  // Close any active session (preserves history).
  const { data: activeSession } = await admin
    .from("table_sessions")
    .select("id, status")
    .eq("table_id", tableId)
    .in("status", ["open", "bill_requested", "payment_pending", "paid"])
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeSession) {
    if (activeSession.status !== "paid") {
      await admin.from("table_sessions").update({ status: "paid" }).eq("id", activeSession.id);
    }
    await admin
      .from("table_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", activeSession.id);
  }

  await admin.from("restaurant_tables").update({ status: "available" }).eq("id", tableId);

  revalidatePath("/dashboard/tables");
  return { error: null };
}
