import { checkCodexProtocol, formatProtocolCheck } from "../codex/protocol-upgrade.js";
import { readPinnedCodexVersion } from "../codex/toolchain.js";
import { errorMessage } from "../shared/errors.js";
import { projectRootFrom } from "../shared/fs.js";
import { Logger } from "../shared/logger.js";

const projectRoot = projectRootFrom(import.meta.url);

try {
  const pinnedVersion = await readPinnedCodexVersion(projectRoot);
  const result = await checkCodexProtocol({
    projectRoot,
    requestedVersion: pinnedVersion,
    apply: true,
    logger: new Logger("info", { component: "protocol-generator" }),
  });
  console.log(formatProtocolCheck(result));
  process.exitCode = result.compatible && result.applied ? 0 : 2;
} catch (error) {
  console.error(`Protocol generation failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
