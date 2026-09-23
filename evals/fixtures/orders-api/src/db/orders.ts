export interface Order {
  id: string;
  customer: string;
  totalCents: number;
}

const ORDERS: Order[] = [
  { id: "ord_1", customer: "Ada", totalCents: 1250 },
  { id: "ord_2", customer: "Grace", totalCents: 990 },
];

/** Returns the order with this id, or `undefined` when there is none. */
export function findOrder(id: string): Order | undefined {
  return ORDERS.find((order) => order.id === id);
}
