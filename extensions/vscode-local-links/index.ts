import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Match code spans and fenced blocks first so examples stay as written.
const CITATION = /(?:^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S])))|(?:(`+)[^\n]*?\2)|\[([^\[\]\n]+)\]\(vscode-local:([^\s()]*)\)/gm;
const AUTHORITY = /^Authority:[ \t]*`([\w.+%-]+)`[ \t]*$/m;

export function expandVscodeLinks(markdown: string, authority: string, cwd: string): string {
  return markdown.replace(CITATION, (match, _fence, _code, label, destination) => {
    if (label === undefined) {
      return match;
    }
    const target = /^(.+):([1-9]\d*)$/.exec(destination || label);
    if (!target) {
      return match;
    }
    let file: string;
    try {
      file = destination ? decodeURIComponent(target[1]) : target[1];
    } catch {
      return match;
    }
    if (/[\u0000-\u001f\u007f]/.test(file)) {
      return match;
    }
    const path = pathToFileURL(resolve(cwd, file)).pathname
      .replaceAll("(", "%28").replaceAll(")", "%29");
    return `[${label}](vscode://vscode-remote/${authority}${path}:${target[2]})`;
  });
}

export default function vscodeLocalLinks(pi: ExtensionAPI): void {
  if ((!process.env.HC_TERMINAL_ID && !process.env.HERDR_PANE_ID) ||
      typeof pi.registerMarkdownTransformer !== "function") {
    return;
  }
  let authority: string | undefined;
  try {
    authority = AUTHORITY.exec(readFileSync(join(homedir(), ".pi/agent/AGENTS.md"), "utf8"))?.[1];
  } catch {
    return;
  }
  if (!authority) {
    return;
  }
  const remote = authority;
  const cwd = process.cwd();
  pi.registerMarkdownTransformer(
    (markdown) => expandVscodeLinks(markdown, remote, cwd),
    { messageTypes: ["assistant"] },
  );
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode === "tui") {
      event.systemPromptOptions.sections.vscode_local_links =
        "For VS Code file citations in this Herdr session, write `[path:line](vscode-local:)` " +
        "with a path relative to the session directory or an absolute container path. " +
        "Pi expands the link for display; use this instead of running vscode-link or emitting a full remote URL.";
    }
  });
}
