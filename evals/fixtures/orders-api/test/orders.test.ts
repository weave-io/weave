import { expect, test } from "bun:test";
import { getOrder } from "../src/api/orders.ts";
import { orderBadge } from "../src/ui/order-badge.ts";

test("returns an existing order", () => {
  expect(getOrder("ord_1")).toEqual({
    status: 200,
    body: { id: "ord_1", customer: "Ada", totalCents: 1250 },
  });
});

test("formats an order badge", () => {
  expect(orderBadge({ id: "ord_2", customer: "Grace", totalCents: 990 })).toBe(
    "ord_2 · Grace · $9.90",
  );
});
