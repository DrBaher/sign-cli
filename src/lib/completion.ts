// Static catalog of commands and flags. Hand-maintained — when you add a new
// command or flag in cli.ts, mirror it here.

const ROOTS = [
  "approve",
  "audit",
  "completion",
  "db",
  "demo",
  "doctor",
  "init",
  "mcp",
  "request",
  "sign",
  "signer",
  "smoke",
  "webhook",
];

const SUBS: Record<string, string[]> = {
  audit: ["show", "verify", "timestamp", "export"],
  db: ["backup", "verify"],
  doctor: ["account-check", "providers"],
  mcp: ["serve"],
  request: [
    "create",
    "run-email",
    "from-template",
    "send",
    "send-embedded",
    "sign-url",
    "launch-embedded",
    "fetch-final",
    "status",
    "watch",
    "remind",
    "cancel",
    "bulk",
    "list",
    "show",
    "verify-signed-pdf",
    "receipt",
  ],
  signer: ["list", "fetch-document", "decline", "reissue-token", "policy"],
  smoke: ["signwell"],
  webhook: ["verify", "ingest", "listen"],
  completion: ["bash", "zsh", "fish"],
};

const SUB_ACTIONS: Record<string, Record<string, string[]>> = {
  signer: { policy: ["run", "run-all"] },
};

const FLAGS = [
  "--auto-approve",
  "--client-id",
  "--csv",
  "--document",
  "--dry-run",
  "--email",
  "--fetch-final",
  "--field",
  "--force",
  "--interval-ms",
  "--interval-seconds",
  "--limit",
  "--log",
  "--out",
  "--param",
  "--path",
  "--payload-file",
  "--port",
  "--prefill",
  "--provider",
  "--reason",
  "--require-hash",
  "--require-signer-email",
  "--require-title",
  "--request-id",
  "--return-url",
  "--signature-id",
  "--signer",
  "--signer-email",
  "--signer-name",
  "--spec",
  "--status",
  "--template-id",
  "--test-mode",
  "--timeout-ms",
  "--timeout-seconds",
  "--title",
  "--token",
  "--token-ttl-minutes",
  "--tokens-file",
  "--tsa-url",
  "--verbose",
  "--yes",
];

const PROVIDERS = ["dropbox", "docusign", "signwell", "local"];

function shCommands(): { roots: string; subsBlock: string; subActionsBlock: string; flags: string; providers: string } {
  const subs = Object.entries(SUBS)
    .map(([root, list]) => `      ${root}) printf %s ${JSON.stringify(list.join(" "))} ;;`)
    .join("\n");
  const subActions: string[] = [];
  for (const [root, byRoot] of Object.entries(SUB_ACTIONS)) {
    for (const [sub, actions] of Object.entries(byRoot)) {
      subActions.push(`      "${root} ${sub}") printf %s ${JSON.stringify(actions.join(" "))} ;;`);
    }
  }
  return {
    roots: ROOTS.join(" "),
    subsBlock: subs,
    subActionsBlock: subActions.join("\n"),
    flags: FLAGS.join(" "),
    providers: PROVIDERS.join(" "),
  };
}

export function generateBashCompletion(): string {
  const { roots, subsBlock, subActionsBlock, flags, providers } = shCommands();
  return `# bash completion for sign-cli — install with:
#   eval "$(sign completion bash)"
_sign_completion() {
  local cur prev words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword="\${COMP_CWORD}"

  if [ "\${prev}" = "--provider" ]; then
    COMPREPLY=( $(compgen -W "${providers}" -- "\${cur}") )
    return
  fi

  if [ "\${cword}" = "1" ]; then
    COMPREPLY=( $(compgen -W "${roots}" -- "\${cur}") )
    return
  fi

  local root="\${COMP_WORDS[1]}"
  local sub="\${COMP_WORDS[2]:-}"

  if [ "\${cword}" = "2" ]; then
    local subs=""
    case "\${root}" in
${subsBlock}
    esac
    if [ -n "\${subs}" ]; then
      COMPREPLY=( $(compgen -W "\${subs}" -- "\${cur}") )
      return
    fi
  fi

  if [ "\${cword}" = "3" ]; then
    local actions=""
    case "\${root} \${sub}" in
${subActionsBlock}
    esac
    if [ -n "\${actions}" ]; then
      COMPREPLY=( $(compgen -W "\${actions}" -- "\${cur}") )
      return
    fi
  fi

  COMPREPLY=( $(compgen -W "${flags}" -- "\${cur}") )
}
complete -F _sign_completion sign
`;
}

export function generateZshCompletion(): string {
  const { roots, flags, providers } = shCommands();
  const subsArrays = Object.entries(SUBS)
    .map(([root, list]) => `  if [ "$1" = "${root}" ]; then printf %s ${JSON.stringify(list.join(" "))}; return; fi`)
    .join("\n");
  return `# zsh completion for sign-cli — install with:
#   sign completion zsh > "\${fpath[1]}/_sign" && compinit
_sign_subs_for() {
${subsArrays}
}

_sign() {
  local -a cmds flags providers
  cmds=( ${ROOTS.map((r) => `'${r}'`).join(" ")} )
  flags=( ${FLAGS.map((f) => `'${f}'`).join(" ")} )
  providers=( ${PROVIDERS.map((p) => `'${p}'`).join(" ")} )

  if (( CURRENT == 2 )); then
    _describe -t commands "sign command" cmds
    return
  fi

  if [[ "\${words[CURRENT-1]}" == "--provider" ]]; then
    _describe -t providers "provider" providers
    return
  fi

  if (( CURRENT == 3 )); then
    local subs=$(_sign_subs_for "\${words[2]}")
    if [[ -n "$subs" ]]; then
      compadd -- $subs
      return
    fi
  fi

  compadd -- $flags
}

compdef _sign sign
# Fallback for shells without compdef registered yet.
[[ -n "\${ZSH_VERSION:-}" ]] && _sign() { compadd -- ${roots} }
`;
}

export function generateFishCompletion(): string {
  const lines: string[] = [
    "# fish completion for sign-cli — install with:",
    "#   sign completion fish > ~/.config/fish/completions/sign.fish",
    "",
    `complete -c sign -n "__fish_use_subcommand" -a "${ROOTS.join(" ")}"`,
  ];
  for (const [root, list] of Object.entries(SUBS)) {
    lines.push(
      `complete -c sign -n "__fish_seen_subcommand_from ${root}; and not __fish_seen_subcommand_from ${list.join(" ")}" -a "${list.join(" ")}"`,
    );
  }
  for (const [root, byRoot] of Object.entries(SUB_ACTIONS)) {
    for (const [sub, actions] of Object.entries(byRoot)) {
      lines.push(
        `complete -c sign -n "__fish_seen_subcommand_from ${sub}" -a "${actions.join(" ")}"`,
      );
      // root context narrowing for clarity
      lines.push(
        `# (above applies under \`sign ${root} ${sub} ...\`)`,
      );
    }
  }
  for (const flag of FLAGS) {
    lines.push(`complete -c sign -l "${flag.replace(/^--/, "")}"`);
  }
  lines.push(
    `complete -c sign -l provider -xa "${PROVIDERS.join(" ")}"`,
  );
  return lines.join("\n") + "\n";
}

export type CompletionShell = "bash" | "zsh" | "fish";

export function generateCompletionScript(shell: CompletionShell): string {
  if (shell === "bash") return generateBashCompletion();
  if (shell === "zsh") return generateZshCompletion();
  if (shell === "fish") return generateFishCompletion();
  throw new Error(`Unsupported shell: ${shell}`);
}
