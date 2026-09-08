import { Plugin } from "@opencode-ai/plugin/tui";
import { PlanPanel } from "./v2/plan-ui.js";

export const WeaveTuiPlugin = Plugin.define({
  id: "weave.tui",
  setup(context) {
    return context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => (
        <PlanPanel context={context} sessionID={sessionID} />
      ),
    });
  },
});

export default WeaveTuiPlugin;
