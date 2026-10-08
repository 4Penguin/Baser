import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoRefresh } from "@/components/auto-refresh";
import { RequestBillButton } from "@/components/menu/request-bill-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getMenuData, resolveTable } from "@/lib/menu-data";
import { createAdminClient } from "@/lib/supabase/admin";

const STATUS_LABEL: Record<string, string> = {
  pending: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  cancelled: "Cancelled",
  completed: "Completed",
};

type TabPageParams = { restaurant: string; branch: string; table: string };

export default async function TableTabPage(
  props: { params: Promise<TabPageParams> },
) {
  const { restaurant: restaurantSlug, branch: branchSlug, table: tableId } = await props.params;
  const data = await getMenuData(restaurantSlug, branchSlug);
  if (!data) notFound();

  const table = await resolveTable(data.branch.id, tableId);
  if (!table) notFound();

  const admin = createAdminClient();

  // Find the active table session (open, bill_requested, payment_pending, or paid).
  const { data: session } = await admin
    .from("table_sessions")
    .select("id, status")
    .eq("table_id", table.id)
    .in("status", ["open", "bill_requested", "payment_pending", "paid"])
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-4 pt-10 text-center">
        <h1 className="text-2xl font-semibold">Table {table.label}</h1>
        <p className="text-muted-foreground">No active tab. Place an order to start a tab.</p>
        <Button asChild className="mx-auto w-fit">
          <Link href={`/menu/${restaurantSlug}/${branchSlug}/${tableId}`}>View menu</Link>
        </Button>
      </div>
    );
  }

  // Fetch all orders for this session (including cancelled for display).
  const { data: orders } = await admin
    .from("orders")
    .select(
      `id, order_number, status, total_amount, created_at,
       order_items(id, item_name, variant_name, quantity)`,
    )
    .eq("table_session_id", session.id)
    .order("created_at");

  const allOrders = orders ?? [];

  // Running total: sum of non-cancelled order totals (same logic as raiseBillForTable).
  const runningTotal = allOrders
    .filter((o) => o.status !== "cancelled")
    .reduce((sum, o) => sum + o.total_amount, 0);

  // Check for existing non-paid bill.
  const { data: bill } = await admin
    .from("bills")
    .select("id, status")
    .eq("table_session_id", session.id)
    .neq("status", "paid")
    .maybeSingle();

  const billRequested = session.status === "bill_requested" || (!!bill && bill.status !== "paid");
  const paymentPending = session.status === "payment_pending";
  const billPaid = session.status === "paid";
  const canOrder = session.status === "open" || session.status === "bill_requested";
  const canRequestBill = session.status === "open" && !bill;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-4 pb-20">
      <AutoRefresh intervalMs={4000} />

      <div className="pt-6 text-center">
        <p className="text-sm text-muted-foreground">{data.restaurant.name}</p>
        <h1 className="text-2xl font-semibold">Table {table.label}</h1>
        <p className="text-sm text-muted-foreground">Your Tab</p>
      </div>

      {allOrders.length === 0 && (
        <p className="text-center text-muted-foreground">No orders yet.</p>
      )}

      {allOrders.map((order) => (
        <div key={order.id} className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Order #{order.order_number}</h2>
            <Badge variant={order.status === "cancelled" ? "destructive" : "outline"}>
              {STATUS_LABEL[order.status] ?? order.status}
            </Badge>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {order.order_items.map((item) => (
              <li key={item.id}>
                {item.item_name}
                {item.variant_name ? ` (${item.variant_name})` : ""} × {item.quantity}
              </li>
            ))}
          </ul>
          {order.status !== "cancelled" && (
            <p className="mt-2 text-right text-sm text-muted-foreground">
              ₹{order.total_amount}
            </p>
          )}
        </div>
      ))}

      <div className="rounded-lg border p-4">
        <div className="flex justify-between font-medium">
          <span>Running total</span>
          <span>₹{runningTotal}</span>
        </div>
      </div>

      {billRequested && !paymentPending && !billPaid && (
        <p className="text-center text-sm font-medium text-brand">Bill requested</p>
      )}
      {paymentPending && (
        <p className="text-center text-sm font-medium text-muted-foreground">Payment in progress…</p>
      )}
      {billPaid && (
        <p className="text-center text-sm font-medium text-brand">Bill paid — thank you!</p>
      )}

      <div className="flex gap-3">
        {canOrder && (
          <Button asChild className="flex-1">
            <Link href={`/menu/${restaurantSlug}/${branchSlug}/${tableId}`}>Order more</Link>
          </Button>
        )}
        {canRequestBill && (
          <RequestBillButton
            branchId={data.branch.id}
            tableId={table.id}
            className="flex-1"
          />
        )}
      </div>
    </div>
  );
}
