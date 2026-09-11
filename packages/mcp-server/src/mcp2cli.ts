#!/usr/bin/env node
/**
 * Token-efficient shell adapter for discord-mcp.
 *
 * mcp2cli discovers the full MCP schema in its own process and exposes tools
 * as dynamic CLI subcommands. AI hosts can therefore use one shell command
 * instead of registering the complete Discord MCP tool catalog in context.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateProfile, normalizeProfileName } from './lib/profiles.js';

const MCP2CLI_VERSION = '3.7.0';

export interface DiscordCliArguments {
  readonly profile: string;
  readonly forwarded: readonly string[];
}

export interface DiscordCliInvocation {
  readonly command: 'uvx';
  readonly args: readonly string[];
}

export const HELP = `Usage:
  discord-mcp2cli --profile <name> --search <pattern>
  discord-mcp2cli --profile <name> --list --top <count> --compact
  discord-mcp2cli --profile <name> <tool-name> [tool-options]

The adapter runs mcp2cli against the local discord-mcp stdio server. It keeps
the complete MCP schema outside the AI host's tool context while preserving
the selected profile's bot identity, guild allowlist, categories, and write
policy. DISCORD_TOKEN must be present in the environment.

Use -- after the profile when a generated tool itself has a --profile option.
`;

/** Quote one argv value for Python shlex.split(), which mcp2cli uses for stdio commands. */
export function quoteForShlex(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Resolve the sibling packaged discord-mcp entrypoint. */
export function resolveDiscordMcpCliPath(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const sibling = resolve(dirname(modulePath), 'cli.js');
  if (existsSync(sibling)) return sibling;

  // Source-mode fallback used by tests; production bundles both files into dist/.
  return fileURLToPath(new URL('./cli.js', moduleUrl));
}

export function parseDiscordCliArguments(argv: readonly string[]): DiscordCliArguments {
  let profile: string | undefined;
  let index = 0;

  while (index < argv.length) {
    const argument = argv[index];
    if (argument === '--') {
      index += 1;
      break;
    }
    if (argument === '--profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--profile requires a value');
      }
      profile = normalizeProfileName(value);
      index += 2;
      continue;
    }
    if (argument?.startsWith('--profile=')) {
      profile = normalizeProfileName(argument.slice('--profile='.length));
      index += 1;
      continue;
    }
    break;
  }

  if (profile === undefined) {
    throw new Error('--profile is required and must appear before mcp2cli arguments');
  }
  const forwarded = argv.slice(index);
  if (forwarded.length === 0) {
    throw new Error('provide --search, --list, or a Discord tool name');
  }
  return { profile, forwarded };
}

export function buildDiscordCliInvocation(
  parsed: DiscordCliArguments,
  options: { readonly nodePath?: string; readonly cliPath?: string } = {},
): DiscordCliInvocation {
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = options.cliPath ?? resolveDiscordMcpCliPath();
  const serverCommand = `${quoteForShlex(nodePath)} ${quoteForShlex(cliPath)} serve`;

  return {
    command: 'uvx',
    args: [
      '--from',
      `mcp2cli==${MCP2CLI_VERSION}`,
      'mcp2cli',
      '--mcp-stdio',
      serverCommand,
      ...parsed.forwarded,
    ],
  };
}

export async function runDiscordCli(argv: readonly string[]): Promise<number> {
  const parsed = parseDiscordCliArguments(argv);
  const childEnv = { ...process.env };
  activateProfile(parsed.profile, { targetEnv: childEnv });

  // mcp2cli owns on-demand discovery, so it needs direct access to the complete
  // allowed catalog. This affects only the child process; profile authorization
  // and write policy remain unchanged.
  childEnv.MCP_TOOL_SURFACE = 'full';
  delete childEnv.GATEWAY;

  const invocation = buildDiscordCliInvocation(parsed);
  return new Promise((resolveExit) => {
    const child = spawn(invocation.command, [...invocation.args], {
      env: childEnv,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(
          'discord-mcp2cli requires uvx. Install uv from https://docs.astral.sh/uv/ and retry.\n',
        );
      } else {
        process.stderr.write(`discord-mcp2cli failed: ${error.message}\n`);
      }
      resolveExit(2);
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        process.stderr.write(`discord-mcp2cli stopped by signal ${signal}\n`);
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

if (process.env.VITEST !== 'true') {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    process.stdout.write(HELP);
  } else {
    try {
      process.exitCode = await runDiscordCli(argv);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
      process.exitCode = 2;
    }
  }
}
