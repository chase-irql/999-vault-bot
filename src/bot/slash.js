/**
 * Registry -> Discord application-command JSON.
 *
 * Pure and discord.js-free: the option type constants are part of Discord's HTTP
 * API, so hard-coding them here costs nothing and keeps this module testable.
 */

const OPTION_TYPES = Object.freeze({ string: 3, integer: 4, boolean: 5 });

const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

function optionJson(option) {
    const type = OPTION_TYPES[option.type];
    if (!type) throw new Error(`Unsupported slash option type "${option.type}" on "${option.name}".`);
    if (!NAME_PATTERN.test(option.name)) throw new Error(`Invalid slash option name "${option.name}".`);

    const json = {
        type,
        name: option.name,
        description: option.description.slice(0, 100),
        required: Boolean(option.required),
    };
    if (option.choices) {
        json.choices = option.choices.map((choice) => ({ name: choice, value: choice }));
    }
    if (option.type === "integer") {
        if (Number.isFinite(option.min)) json.min_value = option.min;
        if (Number.isFinite(option.max)) json.max_value = option.max;
    }
    return json;
}

/**
 * Required options must precede optional ones or Discord rejects the payload,
 * so the declaration order in each command is stable-sorted rather than trusted.
 */
export function buildSlashCommands(commands) {
    return commands.map((command) => {
        if (!NAME_PATTERN.test(command.name)) {
            throw new Error(`Command "${command.name}" is not a valid slash command name.`);
        }
        const options = command.options.map(optionJson);
        const ordered = [...options.filter((o) => o.required), ...options.filter((o) => !o.required)];
        return {
            name: command.name,
            description: command.description.slice(0, 100),
            options: ordered,
            dm_permission: !command.guildOnly,
        };
    });
}

export { OPTION_TYPES };
