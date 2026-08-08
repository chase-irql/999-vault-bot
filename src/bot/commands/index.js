import help from "./help.js";
import ping from "./ping.js";
import play, { playNext } from "./play.js";
import {
    clear,
    join,
    leave,
    loop,
    move,
    nowplaying,
    pause,
    queueCommand,
    remove,
    resume,
    seek,
    shuffle,
    skip,
    stop,
    volume,
} from "./playback.js";
import radio from "./radio.js";
import search from "./search.js";
import song from "./song.js";
import stats from "./stats.js";

/**
 * The command registry. A command is defined exactly once here and reached by
 * both the prefix router and the slash-command handler, which is what keeps the
 * two surfaces from drifting.
 *
 * A registry entry:
 *   name         primary invocation, lowercase
 *   aliases      extra prefix names (aliases are not registered as slash commands)
 *   category     grouping in the generated help embed
 *   description  one line, shown in help and as the slash description
 *   usage        `{prefix}` is substituted at render time
 *   options      discord.js-free slash option specs, in `rest` order
 *   guildOnly    reject in DMs
 *   notes        optional extra paragraph for `help <command>`
 *   execute(ctx) receives a CommandContext, returns/throws
 *
 * Help and slash registration are both generated from this array. There is no
 * second list to keep in sync.
 */

const COMMANDS = [
    play,
    playNext,
    pause,
    resume,
    skip,
    stop,
    queueCommand,
    nowplaying,
    remove,
    move,
    clear,
    shuffle,
    loop,
    seek,
    volume,
    join,
    leave,
    radio,
    song,
    search,
    stats,
    ping,
    help,
];

function assertValid(commands) {
    const seen = new Map();
    for (const command of commands) {
        for (const key of [command.name, ...command.aliases]) {
            if (seen.has(key)) {
                throw new Error(
                    `Command name collision: "${key}" is claimed by both ${seen.get(key)} and ${command.name}.`
                );
            }
            seen.set(key, command.name);
        }
        if (typeof command.execute !== "function") {
            throw new Error(`Command ${command.name} has no execute().`);
        }
    }
}

export function createRegistry(commands = COMMANDS) {
    assertValid(commands);
    const byKey = new Map();
    for (const command of commands) {
        byKey.set(command.name, command);
        for (const alias of command.aliases) byKey.set(alias, command);
    }

    return {
        /** Primary commands, in declaration order. */
        list: () => [...commands],
        /** Resolves a name or alias. */
        find: (key) => byKey.get(String(key ?? "").toLowerCase()) ?? null,
        has: (key) => byKey.has(String(key ?? "").toLowerCase()),
    };
}

export { COMMANDS };
