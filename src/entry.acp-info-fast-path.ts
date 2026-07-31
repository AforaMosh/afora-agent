// Reports the ACP execution contract before config, migrations, or the CLI graph load.
import { ACP_RUNTIME_INFO } from "./acp/runtime-info.js";
import { resolveCliContainerTarget } from "./cli/container-target.js";

export function tryHandleAcpInfoFastPath(
  argv: string[],
  deps: {
    env?: NodeJS.ProcessEnv;
    output?: (message: string) => void;
    exit?: (code?: number) => void;
  } = {},
): boolean {
  if (resolveCliContainerTarget(argv, deps.env)) {
    return false;
  }
  if (argv.length !== 4 || argv[2] !== "acp" || argv[3] !== "info") {
    return false;
  }

  const output = deps.output ?? ((message: string) => process.stdout.write(`${message}\n`));
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  output(JSON.stringify(ACP_RUNTIME_INFO));
  exit(0);
  return true;
}
