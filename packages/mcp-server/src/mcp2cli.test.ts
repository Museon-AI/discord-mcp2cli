import { describe, expect, it } from 'vitest';
import { buildDiscordCliInvocation, parseDiscordCliArguments, quoteForShlex } from './mcp2cli.js';

describe('discord-mcp2cli argument adapter', () => {
  it('keeps discovery arguments out of the wrapper profile parser', () => {
    expect(parseDiscordCliArguments(['--profile', 'devbot', '--search', 'message'])).toEqual({
      profile: 'devbot',
      forwarded: ['--search', 'message'],
    });
  });

  it('passes generated tool flags through after the command name', () => {
    expect(
      parseDiscordCliArguments(['--profile=devbot', 'messages-send', '--profile', 'tool-value']),
    ).toEqual({
      profile: 'devbot',
      forwarded: ['messages-send', '--profile', 'tool-value'],
    });
  });

  it('requires a safe caller-owned profile before discovery or execution', () => {
    expect(() => parseDiscordCliArguments(['--search', 'message'])).toThrow(
      '--profile is required',
    );
    expect(() => parseDiscordCliArguments(['--profile', '../other', '--list'])).toThrow(
      'Profile name must',
    );
  });

  it('builds a pinned mcp2cli invocation without putting a token in argv', () => {
    const invocation = buildDiscordCliInvocation(
      { profile: 'devbot', forwarded: ['--list', '--compact'] },
      { nodePath: '/node path/node', cliPath: "/package's path/cli.js" },
    );

    expect(invocation.command).toBe('uvx');
    expect(invocation.args).toEqual([
      '--from',
      'mcp2cli==3.7.0',
      'mcp2cli',
      '--mcp-stdio',
      `'/node path/node' '/package'"'"'s path/cli.js' serve`,
      '--list',
      '--compact',
    ]);
    expect(invocation.args.join(' ')).not.toContain('DISCORD_TOKEN');
  });

  it('quotes values for mcp2cli Python shlex parsing', () => {
    expect(quoteForShlex("a'b")).toBe(`'a'"'"'b'`);
  });
});
