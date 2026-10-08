import { AutoRefresh } from "@/components/auto-refresh";
import { TableSessionCard } from "@/components/staff/table-session-card";
import { Button } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperationalStaffSession } from "@/lib/staff-session";
import { staffLogout } from "@/app/actions/staff-auth";

const URGENCY: Record<string, number> = {
  payment_pending: 0,
  bill_requested: 1,
  open: 2,
};

const KITCHEN_ACTIVE = ["pending", "preparing", "ready"];

export default async function UnifiedOrdersPage() {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  // Get tables for this restaurant (and branch if specified).
  let tableQuery = admin
    .from("restaurant_tables")
    .select("id, label, branches!inner(id, restaurant_id)")
    .eq("branches.restaurant_id", session.restaurantId);

  if (session.branchId) {
    tableQuery = tableQuery.eq("branch_id", session.branchId);
  }

  const { data: tables } = await tableQuery.order("label");

  const tableMap = new Map((tables ?? []).map((t) => [t.id, t.label]));
  const tableIds = (tables ?? []).map((t) => t.id);

  if (tableIds.length === 0) {
    return (
      <div className="flex min-h-screen flex-col gap-6 bg-muted/20 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Orders</h1>
            <p className="text-muted-foreground">{session.name}</p>
          </div>
          <form action={staffLogout}>
            <Button type="submit" variant="outline">Sign out</Button>
          </form>
        </div>
        <p className="text-sm text-muted-foreground">No tables configured.</p>
      </div>
    );
  }

  // Fetch active table sessions with their orders and bills.
  const { data: sessions } = await admin
    .from("table_sessions")
    .select(
      `id, status, opened_at, table_id,
       orders(id, order_number, status, total_amount, created_at, order_items(id, item_name, variant_name, quantity)),
       bills(id, status, total_amount)`,
    )
    .in("table_id", tableIds)
    .in("status", ["open", "bill_requested", "payment_pending"])
    .order("opened_at", { ascending: false });

  // Sort by urgency: payment_pending > bill_requested > has active kitchen work
  const sortedSessions = (sessions ?? []).sort((a, b) => {
    const aUrgency = URGENCY[a.status] ?? 3;
    const bUrgency = URGENCY[b.status] ?? 3;
    if (aUrgency !== bUrgency) return aUrgency - bUrgency;
    const aActive = (a.orders ?? []).filter((o: { status: string }) => KITCHEN_ACTIVE.includes(o.status)).length;
    const bActive = (b.orders ?? []).filter((o: { status: string }) => KITCHEN_ACTIVE.includes(o.status)).length;
    return bActive - aActive;
  });

  return (
    <div className="flex min-h-screen flex-col gap-6 bg-muted/20 p-4 sm:p-6">
      <AutoRefresh intervalMs={4000} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-muted-foreground">{session.name}</p>
        </div>
        <form action={staffLogout}>
          <Button type="submit" variant="outline">Sign out</Button>
        </form>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sortedSessions.map((s) => (
          <TableSessionCard
            key={s.id}
            session={{
              id: s.id,
              status: s.status,
              tableLabel: tableMap.get(s.table_id) ?? "—",
              orders: (s.orders ?? []).map((o) => ({
                id: o.id,
                order_number: o.order_number,
                status: o.status,
                total_amount: o.total_amount,
                created_at: o.created_at,
                order_items: o.order_items,
              })),
              bill: (s.bills ?? []).find((b) => b.status !== "paid") ?? null,
            }}
          />
        ))}
        {sortedSessions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No active tables. New orders will appear here instantly.
          </p>
        )}
      </div>
    </div>
  );
}
