import { z } from "zod";
import { copySafeGraph } from "./safe-graph-copy.js";

/** Reject unsafe object graphs before a composed Zod schema reads any value. */
export function safeSchemaInput<T extends z.ZodType>(
  schema: T,
): z.ZodType<z.output<T>, z.input<T>> {
  return z.preprocess((input, ctx) => {
    const copied = copySafeGraph(input);
    if (copied.isOk()) return copied.value;
    ctx.issues.push({
      code: "custom",
      input,
      message: copied.error.message,
    });
    return z.NEVER;
  }, schema) as z.ZodType<z.output<T>, z.input<T>>;
}
