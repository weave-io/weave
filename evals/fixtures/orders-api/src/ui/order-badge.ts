import type { Order } from "../db/orders.ts";

/** Formats an order for the order list, e.g. "ord_1 · Ada · $12.50". */
export function orderBadge(order: Order): string {
  const dollars = (order.totalCents / 100).toFixed(2);
  return `${order.id} · ${order.customer} · $${dollars}`;
}
