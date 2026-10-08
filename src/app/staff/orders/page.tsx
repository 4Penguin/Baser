import { AutoRefresh } from "@/components/auto-refresh";
import { UnifiedOrderCard } from "@/components/staff/unified-order-card";
import { Button } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperationalStaffSession } from "@/lib/staff-session";
import { staffLogout } from "@/app/actions/staff-auth";

const ACTIONABLE_STATUSES = ["pending", "preparing", "ready"];

const STATUS_LABEL: Record<string, string> = {
  pending: "New",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
};

export default async function UnifiedOrdersPage() {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  let query = admin
    .from("orders")
    .select(
      "id, order_number, status, created_at, order_items(id, item_name, variant_name, quantity), table_sessions(restaurant_tables(label))",
    )
    .eq("restaurant_id", session.restaurantId)
    .in("status", [...ACTIONABLE_STATUSES, "served"])
    .order("created_at");

  if (session.branchId) {
    query = query.eq("branch_id", session.branchId);
  }

  const { data: orders } = await query;

  const active = (orders ?? []).filter((o) => ACTIONABLE_STATUSES.includes(o.status));
  const served = (orders ?? []).filter((o) => o.status === "served");

  return (
    <div className="flex min-h-screen flex-col gap-6 bg-muted/20 p-4 sm:p-6">
      <AutoRefresh intervalMs={4000} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-muted-foreground">{session.name}</p>
        </div>
        <form action={staffLogout}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">
          Active
          {active.length > 0 ? `(${active.length})` : ""}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((order) => (
            <UnifiedOrderCard
              key={order.id}
              order={{
                id: order.id,
                order_number: order.order_number,
                status: order.status,
                statusLabel: STATUS_LABEL[order.status] ?? order.status,
                created_at: order.created_at,
                order_items: order.order_items,
                tableLabel:
                  (order.table_sessions as unknown as { restaurant_tables: { label: string } } | null)
                    ?.restaurant_tables.label ?? null,
              }}
            />
          ))}
          {active.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active orders. New orders will appear here instantly.
            </p>
          )}
        </div>
      </section>

      {served.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">
            Served
            {served.length > 0 ? `(${served.length})` : ""}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {served.map((order) => (
              <UnifiedOrderCard
                key={order.id}
                order={{
                  id: order.id,
                  order_number: order.order_number,
                  status: order.status,
                  statusLabel: STATUS_LABEL[order.status] ?? order.status,
                  created_at: order.created_at,
                  order_items: order.order_items,
                  tableLabel:
                    (order.table_sessions as unknown as { restaurant_tables: { label: string } } | null)
                      ?.restaurant_tables.label ?? null,
                }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
