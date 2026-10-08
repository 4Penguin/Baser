import { AutoRefresh } from "@/components/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableSessionActions } from "@/components/dashboard/table-session-actions";
import { AddTableForm } from "@/components/dashboard/add-table-form";
import { requireCurrentRestaurant } from "@/lib/restaurant";
import { createAdminClient } from "@/lib/supabase/admin";

const STATUS_VARIANT: Record<string, "default" | "brand" | "secondary" | "destructive" | "outline"> = {
  available: "secondary",
  occupied: "default",
  order_pending: "brand",
  preparing: "default",
  ready: "default",
  bill_requested: "destructive",
  payment_pending: "destructive",
  paid: "default",
  cleaning: "outline",
};

const STATUS_LABEL: Record<string, string> = {
  available: "Available",
  occupied: "Occupied",
  order_pending: "Ordering",
  preparing: "Ordering",
  ready: "Ordering",
  bill_requested: "Bill Requested",
  payment_pending: "Payment Pending",
  paid: "Paid",
  cleaning: "Cleaning",
};

export default async function TablesPage() {
  const restaurant = await requireCurrentRestaurant();
  const admin = createAdminClient();

  const { data: branches } = await admin
    .from("branches")
    .select("id, name")
    .eq("restaurant_id", restaurant.restaurantId)
    .order("name");

  const { data: tables } = await admin
    .from("restaurant_tables")
    .select("id, label, status, branches!inner(id, name, restaurant_id)")
    .eq("branches.restaurant_id", restaurant.restaurantId)
    .order("label");

  // Fetch active sessions with order data for all tables in one query.
  const tableIds = (tables ?? []).map((t) => t.id);
  let sessionsByTable: Record<string, { orderCount: number; billTotal: number }> = {};

  if (tableIds.length > 0) {
    const { data: sessions } = await admin
      .from("table_sessions")
      .select("id, table_id, status, orders(id, status, total_amount)")
      .in("table_id", tableIds)
      .in("status", ["open", "bill_requested", "payment_pending", "paid"]);

    for (const s of sessions ?? []) {
      const activeOrders = (s.orders ?? []).filter((o: { status: string }) => o.status !== "cancelled");
      sessionsByTable[s.table_id] = {
        orderCount: activeOrders.length,
        billTotal: activeOrders.reduce((sum: number, o: { total_amount: number }) => sum + o.total_amount, 0),
      };
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={8000} />
      <div>
        <h1 className="text-2xl font-semibold">Tables</h1>
        <p className="text-muted-foreground">Manage tables across your branches.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a table</CardTitle>
        </CardHeader>
        <CardContent>
          {branches && branches.length > 0 ? (
            <AddTableForm branches={branches} />
          ) : (
            <p className="text-sm text-muted-foreground">Create a branch first.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(tables ?? []).map((table) => {
          const session = sessionsByTable[table.id];
          return (
            <Card key={table.id}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{table.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {(table.branches as unknown as { name: string }).name}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[table.status] ?? "secondary"}>
                    {STATUS_LABEL[table.status] ?? table.status.replace("_", " ")}
                  </Badge>
                </div>
                {session && (
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>{session.orderCount} order{session.orderCount !== 1 ? "s" : ""}</span>
                    <span>₹{session.billTotal}</span>
                  </div>
                )}
                {table.status !== "available" && (
                  <TableSessionActions tableId={table.id} />
                )}
              </CardContent>
            </Card>
          );
        })}
        {(!tables || tables.length === 0) && (
          <p className="text-sm text-muted-foreground">No tables yet.</p>
        )}
      </div>
    </div>
  );
}