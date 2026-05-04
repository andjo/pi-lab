import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 100000) return `${Math.round(count / 1000)}k`;
  if (count < 1000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          // Match the default footer: cumulative usage across all session entries.
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              totalInput += message.usage.input;
              totalOutput += message.usage.output;
              totalCacheRead += message.usage.cacheRead;
              totalCacheWrite += message.usage.cacheWrite;
              totalCost += message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

          // Line 1: cwd + git branch + session name.
          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd = `${pwd} (${branch})`;
          }

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }

          // Line 2 left side: tokens, cache, cost, context usage.
          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription) {
            statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
          }

          // pi's default footer shows "(auto)" when auto-compaction is enabled.
          // Extensions don't currently get the setting, so this mirrors the default setting.
          const autoIndicator = " (auto)";
          const contextPercentDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)}${autoIndicator}`
              : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

          let contextPercentStr: string;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          // Extract plan-mode status so we can place it before the model on line 2.
          const extensionStatuses = footerData.getExtensionStatuses();
          const planModeStatus = extensionStatuses.get("plan-mode");

          // Line 2 right side: provider/model + thinking level, right-aligned like default.
          const modelName = ctx.model?.id || "no-model";
          let rightSideWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            const thinkingLevel = pi.getThinkingLevel();
            rightSideWithoutProvider =
              thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
          }
          if (planModeStatus) {
            rightSideWithoutProvider = `${sanitizeStatusText(planModeStatus)} • ${rightSideWithoutProvider}`;
          }

          let rightSide = rightSideWithoutProvider;
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
              rightSide = rightSideWithoutProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
          let statsLine: string;
          if (totalNeeded <= width) {
            statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              const truncatedRightWidth = visibleWidth(truncatedRight);
              statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth)) + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          // Dim around context coloring the same way default footer does.
          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);

          const lines = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            dimStatsLeft + dimRemainder,
          ];

          // Line 3: statuses from other extensions, sorted by key like default.
          // Line 4: pi-vscode gets its own line because it can be long.
          // Note: plan-mode is handled on line 2, pi-vscode on line 4.
          if (extensionStatuses.size > 0) {
            const regularStatuses: string[] = [];
            let vscodeStatus: string | undefined;

            for (const [key, text] of Array.from(extensionStatuses.entries()).sort(([a], [b]) => a.localeCompare(b))) {
              const sanitized = sanitizeStatusText(text);
              if (key === "pi-vscode") {
                vscodeStatus = sanitized;
              } else if (key === "plan-mode") {
                // handled on line 2
                continue;
              } else {
                regularStatuses.push(sanitized);
              }
            }

            if (regularStatuses.length > 0) {
              const statusLine = regularStatuses.join(" ");
              lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
            }

            if (vscodeStatus) {
              lines.push(truncateToWidth(vscodeStatus, width, theme.fg("dim", "...")));
            }
          }

          return lines;
        },
      };
    });
  });
}
