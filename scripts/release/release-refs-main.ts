import { logger } from "@weaveio/weave-engine";
import { z } from "zod";

const log = logger.child({ module: "release-refs-main" });
const Input = z.object({ authorization: z.string().min(1), appToken: z.string().min(1), payloadDirectory: z.string().min(1) }).strict();
const input = Input.safeParse({ authorization: Bun.env.RELEASE_PROMOTION_AUTHORIZATION, appToken: Bun.env.RELEASE_APP_TOKEN, payloadDirectory: Bun.env.RELEASE_PAYLOAD_DIRECTORY });
if (!input.success) {
  log.error({ issues: input.error.issues }, "invalid release references input");
  process.exitCode = 2;
} else {
  // The release-ref mutation requires the bound manifest/train payload. This
  // explicit executable boundary refuses to run until that payload is supplied.
  const manifest = Bun.file(`${input.data.payloadDirectory}/manifest.json`);
  if (!(await manifest.exists())) {
    log.error("missing bound payload manifest");
    process.exitCode = 2;
  } else log.info("release references input accepted");
}
