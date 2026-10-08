"use client";

import { useTransition } from "react";

import { advanceOrderStatusUnified } from "@/app/actions/staff-ops";
import { PaymentControls } from "@/components/staff/payment-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_LABEL: Record<string, string> = {
  open: "Dining",
  bill_requested: "Bill Requested",
  payment_pending: "Payment Pending",
};

const STATUS_VARIANT: Record<string, "default" | "brand" | "secondary" | "destructive" | "outline"> = {
  open: "secondary",
  bill_requested: "destructive",
  payment_pending: "destructive",
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "New",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
};

const ACTION_LABEL: Record<string, string> = {
  pending: "Start preparing",
  preparing: "Mark ready",
  ready: "Mark served",
};

const KITCHEN_ACTIVE = ["pending", "preparing", "ready"];

type OrderItem = { id: string; item_name: string; variant_name: string | null; quantity: number };

type Order = {
  id: string;
  order_number: number;
  status: string;
  total_amount: number;
  created_at: string;
  order_items: OrderItem[];
};

type Bill = { id: string; status: string; total_amount: number } | null;

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function OrderTicket({ order }: { order: Order }) {
  const [isPending, startTransition] = useTransition();
  const actionLabel = ACTION_LABEL[order.status];

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Order #{order.order_number}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{ageLabel(order.created_at)}</span>
          <Badge variant="outline">{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
        </div>
      </div>
      <ul className="mt-1.5 text-sm text-muted-foreground">
        {order.order_items.map((item) => (
          <li key={item.id}>
            {item.item_name}{item.variant_name ? ` (${item.variant_name})` : ""} × {item.quantity}
          </li>
        ))}
      </ul>
      {actionLabel && (
        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={isPending}
          onClick={() => startTransition(() => advanceOrderStatusUnified(order.id))}
        >
          {isPending ? "Updating…" : actionLabel}
        </Button>
      )}
    </div>
  );
}

export function TableSessionCard({
  session,
}: {
  session: {
    id: string;
    status: string;
    tableLabel: string;
    orders: Order[];
    bill: Bill;
  };
}) {
  const activeOrders = session.orders.filter((o) => KITCHEN_ACTIVE.includes(o.status));
  const servedOrders = session.orders.filter((o) => o.status === "served");
  const allOrders = session.orders.filter((o) => o.status !== "cancelled");
  const runningTotal = allOrders.reduce((sum, o) => sum + o.total_amount, 0);
  const showPayment = session.status === "bill_requested" || session.status === "payment_pending";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Table {session.tableLabel}</CardTitle>
        <Badge variant={STATUS_VARIANT[session.status] ?? "secondary"}>
          {STATUS_LABEL[session.status] ?? session.status}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {activeOrders.length > 0 && (
          <div className="flex flex-col gap-2">
            {activeOrders.map((order) => (
              <OrderTicket key={order.id} order={order} />
            ))}
          </div>
        )}

        {servedOrders.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {servedOrders.length} served order{servedOrders.length !== 1 ? "s" : ""}
          </p>
        )}

        <div className="flex items-center justify-between border-t pt-2 text-sm">
          <span className="text-muted-foreground">
            {allOrders.length} order{allOrders.length !== 1 ? "s" : ""} · Running total
          </span>
          <span className="font-medium">₹{runningTotal}</span>
        </div>

        {showPayment && session.bill && (
          <PaymentControls bill={session.bill} sessionStatus={session.status} />
        )}
      </CardContent>
    </Card>
  );
}
