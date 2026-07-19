import { logger } from "@weaveio/weave-engine";
import { Result } from "neverthrow";
import { promotionCommands } from "./promotion-commands.js";

const log = logger.child({ module: "promotion-commands" });
const authorization = Result.fromThrowable(
  () => JSON.parse(Bun.env.RELEASE_PROMOTION_AUTHORIZATION ?? ""),
  () => ({ type: "InvalidPromotionAuthorization" as const }),
)();
if (authorization.isErr()) {
  log.error("invalid promotion authorization JSON");
  process.exit(2);
}
const commands = promotionCommands(authorization.value);
if (commands.isErr()) {
  log.error("invalid promotion authorization record");
  process.exit(2);
}
process.stdout.write(
  `${commands.value.priorLatestCaptureCommands.join("\n")}\n`,
);
process.stdout.write(`${commands.value.promoteCommands.join("\n")}\n`);
