import { UserError } from "../../core/errors.js";
import { commandHelpEmbed, helpEmbed } from "../embeds.js";

export default {
    name: "help",
    aliases: ["h", "commands"],
    category: "Utility",
    description: "List every command, or explain one.",
    usage: "{prefix}help [command]",
    options: [{ name: "command", description: "Command to explain", type: "string", required: false }],
    guildOnly: false,
    async execute(ctx) {
        const { registry: commands, config } = ctx.deps;
        const prefix = config.prefix;
        const requested = ctx.args[0]?.toLowerCase();

        if (!requested) {
            // Generated from the registry, never a maintained string.
            return ctx.reply({ embeds: [helpEmbed(commands.list(), { prefix })] });
        }

        const command = commands.find(requested);
        if (!command) {
            throw new UserError(
                `There is no \`${prefix}${requested}\` command. Run \`${prefix}help\` for the list.`
            );
        }
        return ctx.reply({ embeds: [commandHelpEmbed(command, { prefix })] });
    },
};
