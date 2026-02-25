/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { MessageJSON } from "@vencord/discord-types";
import { MessageType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.MessageEmojiCache as PluginNative<typeof import("./native")>;

const logger = new Logger("MessageEmojiCache");

/** Regex to match custom Discord emojis: <:name:id> or <a:name:id> (with optional ~N suffix on name) */
const CUSTOM_EMOJI_REGEX = /<a?:(\w+)(?:~\d+)?:(\d+)>/g;

interface ExtractedEmoji {
    id: string;
    name: string;
    guildName: string;
}

/** Resolve the guild name for a given channel ID */
function resolveGuildName(channelId: string): string | null {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.guild_id) return null;

    const guild = GuildStore.getGuild(channel.guild_id);
    return guild?.name ?? null;
}

/** Extract all custom emojis from a message's content */
function extractEmojisFromContent(content: string, guildName: string): ExtractedEmoji[] {
    const emojis: ExtractedEmoji[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    CUSTOM_EMOJI_REGEX.lastIndex = 0;

    while ((match = CUSTOM_EMOJI_REGEX.exec(content)) !== null) {
        const [, name, id] = match;

        // Deduplicate within a single message
        if (seen.has(id)) continue;
        seen.add(id);

        emojis.push({ id, name, guildName });
    }

    return emojis;
}

const settings = definePluginSettings({
    emoteCacheDir: {
        type: OptionType.STRING,
        description: "Directory to store cached emoji images. Leave blank to use the default Vencord data directory.",
        default: ""
    },
    emojiSize: {
        type: OptionType.SELECT,
        description: "Size of cached emoji images in pixels.",
        options: [
            { label: "48px", value: 48 },
            { label: "64px", value: 64 },
            { label: "96px", value: 96 },
            { label: "128px", value: 128, default: true },
            { label: "256px", value: 256 },
        ]
    }
});

export default definePlugin({
    name: "MessageEmojiCache",
    description: "Caches custom emojis from messages as .png files, organized by guild in your config directory.",
    authors: [{ name: "dotBeeps", id: 130151971431776256n }],
    settings,

    async start() {
        try {
            const dir = settings.store.emoteCacheDir || undefined;
            const count = await Native.initCache(dir);
            logger.info(`Initialized emoji cache with ${count} existing emojis.`);
        } catch (error) {
            logger.error("Failed to initialize emoji cache:", error);
        }
    },

    flux: {
        async MESSAGE_CREATE({ optimistic, message, channelId }: { optimistic: boolean; channelId: string; message: MessageJSON; }) {
            if (optimistic) return;
            if (message.type !== MessageType.DEFAULT && message.type !== MessageType.REPLY) return;
            if (message.state === "SENDING") return;

            const guildName = resolveGuildName(channelId);
            if (!guildName) return; // Skip DMs and group DMs

            const emojis: ExtractedEmoji[] = [];

            // Extract from message content
            if (message.content) {
                emojis.push(...extractEmojisFromContent(message.content, guildName));
            }

            if (emojis.length === 0) return;

            try {
                const dir = settings.store.emoteCacheDir || undefined;
                const size = settings.store.emojiSize;
                const cached = await Native.cacheEmojis(emojis, dir, size);

                if (cached > 0) {
                    logger.info(`Cached ${cached} new emoji(s) from #${channelId}`);
                }
            } catch (error) {
                logger.error("Failed to cache emojis:", error);
            }
        }
    }
});
