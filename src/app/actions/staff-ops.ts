"use server";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperationalStaffSession, requireStaffSession } from "@/lib/staff-session";

const KITCHEN_NEXT_STATUS: Record<string, string> = {
  pending: "accepted",
  accepted: "preparing",
  preparing: "ready",
};

export async function advanceOrderStatus(orderId: string) {
  const session = await requireStaffSession("kitchen");
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, status, restaurant_id")
    .eq("id", orderId)
    .eq("restaurant_id", session.restaurantId)
    .single();

  if (!order) return;

  const nextStatus = KITCHEN_NEXT_STATUS[order.status];
  if (!nextStatus) return;

  await admin.from("orders").update({ status: nextStatus }).eq("id", orderId);
  await admin.from("order_status_history").insert({
    order_id: orderId,
    status: nextStatus,
    changed_by_staff_id: session.staffId,
  });

  revalidatePath("/staff/kitchen");
}

/**
 * Waiter picks up a ready order and takes it to the table.
 *
 * Kitchen's last step is "ready" — without this the order would sit there
 * forever, since nothing else advances it to "served" (PRD section 22).
 */
export async function markOrderServed(orderId: string) {
  const session = await requireStaffSession("waiter");
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, status, table_session_id")
    .eq("id", orderId)
    .eq("restaurant_id", session.restaurantId)
    .eq("status", "ready")
    .maybeSingle();

  if (!order) return;

  await admin.from("orders").update({ status: "served" }).eq("id", orderId);
  await admin.from("order_status_history").insert({
    order_id: orderId,
    status: "served",
    changed_by_staff_id: session.staffId,
  });

  // Reflect it on the floor plan: the table is occupied and eating rather
  // than waiting on the kitchen.
  if (order.table_session_id) {
    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("table_id, status")
      .eq("id", order.table_session_id)
      .maybeSingle();

    if (tableSession?.table_id && tableSession.status === "open") {
      await admin
        .from("restaurant_tables")
        .update({ status: "occupied" })
        .eq("id", tableSession.table_id);
    }
  }

  revalidatePath("/staff/waiter");
}

export async function resolveWaiterRequest(requestId: string) {
  const session = await requireStaffSession("waiter");
  const admin = createAdminClient();

  await admin
    .from("waiter_requests")
    .update({ resolved_at: new Date().toISOString(), resolved_by_staff_id: session.staffId })
    .eq("id", requestId)
    .eq("branch_id", session.branchId ?? "");

  revalidatePath("/staff/waiter");
}

export async function markBillPaid(billId: string, method: "cash" | "upi" | "card") {
  const session = await requireStaffSession("cashier");
  const admin = createAdminClient();

  const { data: bill } = await admin
    .from("bills")
    .select("id, total_amount, restaurant_id, table_session_id, status")
    .eq("id", billId)
    .eq("restaurant_id", session.restaurantId)
    .single();

  if (!bill) return;

  // Idempotency: if the bill is already paid, do not duplicate the payment
  // or close the session again (duplicate webhook, double-tap).
  if (bill.status === "paid") return;

  await admin
    .from("bills")
    .update({ status: "paid", closed_at: new Date().toISOString() })
    .eq("id", billId);

  await admin.from("payments").insert({
    restaurant_id: session.restaurantId,
    bill_id: billId,
    method,
    status: "paid",
    amount: bill.total_amount,
    recorded_by_staff_id: session.staffId,
  });

  if (bill.table_session_id) {
    // Payment is the end of the lifecycle: everything still open on this
    // table session becomes "completed", otherwise orders would linger as
    // served/ready forever and skew the dashboard's pending count.
    const { data: openOrders } = await admin
      .from("orders")
      .select("id")
      .eq("table_session_id", bill.table_session_id)
      .not("status", "in", "(completed,cancelled)");

    if (openOrders && openOrders.length > 0) {
      const ids = openOrders.map((o) => o.id);
      await admin.from("orders").update({ status: "completed" }).in("id", ids);
      await admin.from("order_status_history").insert(
        ids.map((id) => ({
          order_id: id,
          status: "completed",
          changed_by_staff_id: session.staffId,
        })),
      );
    }

    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("id, table_id, status")
      .eq("id", bill.table_session_id)
      .maybeSingle();

    if (tableSession && tableSession.status !== "closed") {
      // Transition: bill_requested (or payment_pending) -> paid -> closed.
      // The DB trigger validates each step.
      if (tableSession.status !== "paid") {
        await admin
          .from("table_sessions")
          .update({ status: "paid" })
          .eq("id", bill.table_session_id);
      }
      await admin
        .from("table_sessions")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", bill.table_session_id);

      if (tableSession.table_id) {
        await admin
          .from("restaurant_tables")
          .update({ status: "paid" })
          .eq("id", tableSession.table_id);
        await admin
          .from("restaurant_tables")
          .update({ status: "cleaning" })
          .eq("id", tableSession.table_id);
      }
    }
  }

  revalidatePath("/staff/cashier");
  revalidatePath("/staff/orders");
}

const UNIFIED_NEXT_STATUS: Record<string, string> = {
  pending: "preparing",
  preparing: "ready",
  ready: "served",
};

/**
 * Unified operational staff advance an order through its whole lifecycle on
 * one screen: New (pending) → Preparing → Ready → Served.
 *
 * One PIN login (role "staff") replaces the separate kitchen/waiter/cashier
 * sign-ins. The table session is NOT closed when an order is served — only
 * payment closes a session, so customers can place further order rounds.
 */
export async function advanceOrderStatusUnified(orderId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, status, restaurant_id, table_session_id")
    .eq("id", orderId)
    .eq("restaurant_id", session.restaurantId)
    .single();

  if (!order) return;

  const nextStatus = UNIFIED_NEXT_STATUS[order.status];
  if (!nextStatus) return;

  await admin.from("orders").update({ status: nextStatus }).eq("id", orderId);
  await admin.from("order_status_history").insert({
    order_id: orderId,
    status: nextStatus,
    changed_by_staff_id: session.staffId,
  });

  // Reflect a served order on the floor plan: the table is occupied and
  // eating. The table session stays OPEN so customers can order again —
  // only markBillPaid (payment) closes a session.
  if (nextStatus === "served" && order.table_session_id) {
    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("table_id, status")
      .eq("id", order.table_session_id)
      .maybeSingle();

    if (tableSession?.table_id && tableSession.status === "open") {
      await admin
        .from("restaurant_tables")
        .update({ status: "occupied" })
        .eq("id", tableSession.table_id);
    }
  }

  revalidatePath("/staff/orders");
}

/**
 * Initiates payment for a table session. Transitions the session from
 * bill_requested to payment_pending, freezing new orders. The bill total
 * is recalculated one final time to ensure it is stable.
 */
export async function initiatePayment(billId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: bill } = await admin
    .from("bills")
    .select("id, status, table_session_id, restaurant_id")
    .eq("id", billId)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();

  if (!bill || bill.status === "paid") return;

  // Recalculate bill total one final time (freezes the amount).
  const { data: orders } = await admin
    .from("orders")
    .select("total_amount")
    .eq("table_session_id", bill.table_session_id)
    .neq("status", "cancelled");

  const totalAmount = (orders ?? []).reduce((sum, o) => sum + o.total_amount, 0);

  await admin.from("bills").update({ total_amount: totalAmount }).eq("id", billId);
  await admin.from("table_sessions").update({ status: "payment_pending" }).eq("id", bill.table_session_id);

  const { data: tableSession } = await admin
    .from("table_sessions")
    .select("table_id")
    .eq("id", bill.table_session_id)
    .maybeSingle();

  if (tableSession?.table_id) {
    await admin.from("restaurant_tables").update({ status: "payment_pending" }).eq("id", tableSession.table_id);
  }

  revalidatePath("/staff/orders");
}

/**
 * Confirms payment for a table session. Transitions from payment_pending
 * to paid then closed. Records the payment with the selected method.
 * Idempotent: if the bill is already paid, does nothing.
 */
export async function confirmPayment(billId: string, method: "cash" | "upi" | "card") {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: bill } = await admin
    .from("bills")
    .select("id, total_amount, restaurant_id, table_session_id, status")
    .eq("id", billId)
    .eq("restaurant_id", session.restaurantId)
    .single();

  if (!bill || bill.status === "paid") return;

  await admin.from("bills").update({ status: "paid", closed_at: new Date().toISOString() }).eq("id", billId);

  await admin.from("payments").insert({
    restaurant_id: session.restaurantId,
    bill_id: billId,
    method,
    status: "paid",
    amount: bill.total_amount,
    recorded_by_staff_id: session.staffId,
  });

  if (bill.table_session_id) {
    // Close any open orders so they don't linger as served/ready forever.
    const { data: openOrders } = await admin
      .from("orders")
      .select("id")
      .eq("table_session_id", bill.table_session_id)
      .not("status", "in", "(completed,cancelled)");

    if (openOrders && openOrders.length > 0) {
      const ids = openOrders.map((o) => o.id);
      await admin.from("orders").update({ status: "completed" }).in("id", ids);
      await admin.from("order_status_history").insert(
        ids.map((id) => ({
          order_id: id,
          status: "completed",
          changed_by_staff_id: session.staffId,
        })),
      );
    }

    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("id, table_id, status")
      .eq("id", bill.table_session_id)
      .maybeSingle();

    if (tableSession && tableSession.status !== "closed") {
      if (tableSession.status !== "paid") {
        await admin.from("table_sessions").update({ status: "paid" }).eq("id", bill.table_session_id);
      }
      await admin
        .from("table_sessions")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", bill.table_session_id);

      if (tableSession.table_id) {
        await admin.from("restaurant_tables").update({ status: "paid" }).eq("id", tableSession.table_id);
        await admin.from("restaurant_tables").update({ status: "cleaning" }).eq("id", tableSession.table_id);
      }
    }
  }

  revalidatePath("/staff/orders");
}

/**
 * Cancels payment initiation. Transitions the session from payment_pending
 * back to bill_requested, allowing ordering to resume.
 */
export async function cancelPaymentInitiation(billId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: bill } = await admin
    .from("bills")
    .select("id, status, table_session_id, restaurant_id")
    .eq("id", billId)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();

  if (!bill || bill.status === "paid") return;

  await admin.from("table_sessions").update({ status: "bill_requested" }).eq("id", bill.table_session_id);

  const { data: tableSession } = await admin
    .from("table_sessions")
    .select("table_id")
    .eq("id", bill.table_session_id)
    .maybeSingle();

  if (tableSession?.table_id) {
    await admin.from("restaurant_tables").update({ status: "bill_requested" }).eq("id", tableSession.table_id);
  }

  revalidatePath("/staff/orders");
}



/**
 * Marks an order as ready. Transitions from pending/accepted/preparing to
 * ready in a single action, simplifying the staff workflow (NEW -> READY).
 */
export async function markOrderReady(orderId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, status, restaurant_id, table_session_id")
    .eq("id", orderId)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();

  if (!order || !["pending", "accepted", "preparing"].includes(order.status)) return;

  await admin.from("orders").update({ status: "ready" }).eq("id", orderId);
  await admin.from("order_status_history").insert({
    order_id: orderId,
    status: "ready",
    changed_by_staff_id: session.staffId,
  });

  if (order.table_session_id) {
    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("table_id, status")
      .eq("id", order.table_session_id)
      .maybeSingle();

    if (tableSession?.table_id && ["open", "bill_requested"].includes(tableSession.status)) {
      const { data: stillActive } = await admin
        .from("orders")
        .select("id")
        .eq("table_session_id", order.table_session_id)
        .in("status", ["pending", "accepted", "preparing"])
        .limit(1)
        .maybeSingle();

      await admin
        .from("restaurant_tables")
        .update({ status: stillActive ? "preparing" : "ready" })
        .eq("id", tableSession.table_id);
    }
  }

  revalidatePath("/staff/orders");
}

/**
 * Marks an order as served. Transitions ready -> served.
 */
export async function markOrderServed(orderId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select("id, status, restaurant_id, table_session_id")
    .eq("id", orderId)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();

  if (!order || order.status !== "ready") return;

  await admin.from("orders").update({ status: "served" }).eq("id", orderId);
  await admin.from("order_status_history").insert({
    order_id: orderId,
    status: "served",
    changed_by_staff_id: session.staffId,
  });

  if (order.table_session_id) {
    const { data: tableSession } = await admin
      .from("table_sessions")
      .select("table_id, status")
      .eq("id", order.table_session_id)
      .maybeSingle();

    if (tableSession?.table_id && ["open", "bill_requested"].includes(tableSession.status)) {
      const { data: stillReady } = await admin
        .from("orders")
        .select("id")
        .eq("table_session_id", order.table_session_id)
        .eq("status", "ready")
        .limit(1)
        .maybeSingle();

      const { data: stillActive } = await admin
        .from("orders")
        .select("id")
        .eq("table_session_id", order.table_session_id)
        .in("status", ["pending", "accepted", "preparing"])
        .limit(1)
        .maybeSingle();

      let tableStatus = "occupied";
      if (stillReady) tableStatus = "ready";
      else if (stillActive) tableStatus = "preparing";

      await admin.from("restaurant_tables").update({ status: tableStatus }).eq("id", tableSession.table_id);
    }
  }

  revalidatePath("/staff/orders");
}

/**
 * Closes a table session. Used by staff to close a tab after payment is
 * handled externally or to clear a tab without payment.
 * - "external": records a cash payment and marks the bill as paid
 * - "unpaid": closes the session without recording a payment
 * Both options close any open orders, close the session, and make the
 * table available for the next guests.
 */
export async function closeTableSession(
  sessionId: string,
  resolution: "external" | "unpaid",
) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: tableSession } = await admin
    .from("table_sessions")
    .select("id, status, table_id, restaurant_id")
    .eq("id", sessionId)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();

  if (!tableSession) return { error: "Session not found." };
  if (tableSession.status === "closed") return { error: null };

  if (resolution === "external") {
    const { data: bill } = await admin
      .from("bills")
      .select("id, total_amount, status")
      .eq("table_session_id", sessionId)
      .neq("status", "paid")
      .maybeSingle();

    if (bill) {
      await admin.from("bills").update({ status: "paid", closed_at: new Date().toISOString() }).eq("id", bill.id);
      await admin.from("payments").insert({
        restaurant_id: session.restaurantId,
        bill_id: bill.id,
        method: "cash",
        status: "paid",
        amount: bill.total_amount,
        recorded_by_staff_id: session.staffId,
      });
    }
  }

  const { data: openOrders } = await admin
    .from("orders")
    .select("id")
    .eq("table_session_id", sessionId)
    .in("status", ["pending", "accepted", "preparing", "ready"]);

  if (openOrders && openOrders.length > 0) {
    const ids = openOrders.map((o) => o.id);
    await admin.from("orders").update({ status: "completed" }).in("id", ids);
    await admin.from("order_status_history").insert(
      ids.map((id) => ({
        order_id: id,
        status: "completed",
        changed_by_staff_id: session.staffId,
      })),
    );
  }

  if (tableSession.status !== "paid") {
    await admin.from("table_sessions").update({ status: "paid" }).eq("id", sessionId);
  }
  await admin
    .from("table_sessions")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", sessionId);

  if (tableSession.table_id) {
    await admin.from("restaurant_tables").update({ status: "available" }).eq("id", tableSession.table_id);
  }

  revalidatePath("/staff/orders");
  return { error: null };
}

/**
 * Staff override: reset an abandoned or stuck table. Closes any active
 * session and returns the table to "available". All historical orders,
 * payments, and the session record itself are preserved.
 */
export async function resetTable(tableId: string) {
  const session = await requireOperationalStaffSession();
  const admin = createAdminClient();

  const { data: table } = await admin
    .from("restaurant_tables")
    .select("id, branches(restaurant_id)")
    .eq("id", tableId)
    .maybeSingle();

  if (!table) return { error: "Table not found." };

  const tableRestaurantId = (table.branches as unknown as { restaurant_id: string }).restaurant_id;
  if (tableRestaurantId !== session.restaurantId) {
    return { error: "Unauthorized." };
  }

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

  revalidatePath("/staff/orders");
  revalidatePath("/dashboard/tables");
  return { error: null };
}
