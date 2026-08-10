import path from "node:path";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { MediaContent } from "../../../llm/types.js";
import {
  resolveInboundMediaReference,
  resolveMediaReferenceLocalPath,
} from "../../../media/media-reference.js";
import { loadWebMedia } from "../../../media/web-media.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "../../sandbox-media-paths.js";
import { log } from "../logger.js";
import type { DetectedPromptMediaRef, PromptMediaReadOptions } from "./prompt-media.js";

/** Securely resolves and reads a prompt media reference within its declared boundaries. */
export async function loadPromptMediaFromRef(
  ref: DetectedPromptMediaRef,
  workspaceDir: string,
  options: PromptMediaReadOptions,
): Promise<MediaContent | null> {
  try {
    let targetPath = ref.resolved;
    let managedInboundHostRead = false;

    if (!options.sandbox) {
      targetPath = await resolveMediaReferenceLocalPath(targetPath);
    }

    if (options.sandbox) {
      try {
        const resolved = await resolveSandboxedBridgeMediaPath({
          sandbox: {
            root: options.sandbox.root,
            bridge: options.sandbox.bridge,
            workspaceOnly: options.workspaceOnly,
          },
          mediaPath: targetPath,
          inboundFallbackDir: "media/inbound",
        });
        targetPath = resolved.resolved;
      } catch (err) {
        // Gateway-owned inbound video is intentionally never staged: the sandbox's
        // tool-file limit is smaller than the model's native-video contract.
        const inbound =
          options.kind === "video"
            ? await resolveInboundMediaReference(targetPath).catch(() => undefined)
            : undefined;
        if (!inbound) {
          log.debug(
            `Native ${options.kind}: sandbox validation failed for ${ref.resolved}: ${formatErrorMessage(err)}`,
          );
          return null;
        }
        targetPath = inbound.physicalPath;
        managedInboundHostRead = true;
      }
    } else if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(workspaceDir, targetPath);
    }

    const media =
      options.sandbox && !managedInboundHostRead
        ? await loadWebMedia(targetPath, {
            maxBytes: options.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: options.sandbox }),
          })
        : await loadWebMedia(
            targetPath,
            options.workspaceOnly || options.localRoots || managedInboundHostRead
              ? {
                  maxBytes: options.maxBytes,
                  localRoots: managedInboundHostRead
                    ? [...(options.localRoots ?? [workspaceDir]), path.dirname(targetPath)]
                    : (options.localRoots ?? [workspaceDir]),
                }
              : options.maxBytes,
          );

    if (media.kind !== options.kind) {
      log.debug(`Native ${options.kind}: unexpected media kind: ${targetPath} (got ${media.kind})`);
      return null;
    }

    const mimeType = media.contentType ?? (options.kind === "image" ? "image/jpeg" : "video/mp4");
    const data = media.buffer.toString("base64");

    return options.kind === "image"
      ? { type: "image", data, mimeType }
      : { type: "video", data, mimeType };
  } catch (err) {
    log.debug(`Native ${options.kind}: failed to load ${ref.resolved}: ${formatErrorMessage(err)}`);
    return null;
  }
}
