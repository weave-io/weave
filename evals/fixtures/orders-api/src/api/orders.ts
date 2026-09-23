import { findOrder } from "../db/orders.ts";

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** Handles `GET /orders/:id`. */
export function getOrder(id: string): HttpResponse {
  const order = findOrder(id);
  return { status: 200, body: order ?? null };
}
