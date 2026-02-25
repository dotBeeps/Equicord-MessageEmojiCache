/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, existsSync } from "original-fs";
import { join } from "path";

import { IpcMainInvokeEvent } from "electron";

import { DATA_DIR } from "@main/utils/constants";
import { fetchBuffer } from "@main/utils/http";

const EMOJI_CDN_BASE = "https://cdn.discordapp.com/emojis";

/** Characters unsafe for directory/file names */
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** In-memory set of emoji IDs we've already cached to disk */
const cachedEmojiIds = new Set<string>();

/** Sanitize a string for use as a filesystem-safe directory or file name */
function sanitizeName(name: string): string {
    return name
        .replace(UNSAFE_FILENAME_CHARS, "_")
        .replace(/\.+$/, "")
        .trim() || "unknown";
}

/** Resolve the base emote cache directory, defaulting to DATA_DIR/emotes */
function resolveBaseDir(customDir?: string): string {
    if (customDir && customDir.trim().length > 0) {
        return customDir.replace(/^~/, process.env.HOME ?? "");
    }

    return join(DATA_DIR, "emotes");
}

/** Ensure a directory exists, creating it recursively if needed */
function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

/** Build the Discord CDN URL for a given emoji as PNG */
function buildEmojiUrl(emojiId: string, size: number): string {
    return `${EMOJI_CDN_BASE}/${emojiId}.png?size=${size}&quality=lossless`;
}

/**
 * Download and cache a single emoji to disk.
 * Skips if already cached (in-memory check + filesystem check).
 */
export async function cacheEmoji(
    _: IpcMainInvokeEvent,
    emojiId: string,
    emojiName: string,
    guildName: string,
    customDir?: string,
    size: number = 128
): Promise<{ cached: boolean; path: string; }> {
    if (cachedEmojiIds.has(emojiId)) {
        return { cached: false, path: "" };
    }

    const baseDir = resolveBaseDir(customDir);
    const safeGuildName = sanitizeName(guildName);
    const guildDir = join(baseDir, safeGuildName);

    const fileName = `${sanitizeName(emojiName)}-${emojiId}.png`;
    const filePath = join(guildDir, fileName);

    // Filesystem-level cache check
    if (existsSync(filePath)) {
        cachedEmojiIds.add(emojiId);
        return { cached: false, path: filePath };
    }

    try {
        ensureDir(guildDir);

        const url = buildEmojiUrl(emojiId, size);
        const buffer = await fetchBuffer(url);

        const { writeFileSync } = require("original-fs");
        writeFileSync(filePath, buffer);

        cachedEmojiIds.add(emojiId);
        return { cached: true, path: filePath };
    } catch (error) {
        console.error(`[MessageEmojiCache] Failed to cache emoji ${emojiName} (${emojiId}):`, error);
        return { cached: false, path: "" };
    }
}

/**
 * Batch-cache multiple emojis from a single message.
 * Returns the count of newly cached emojis.
 */
export async function cacheEmojis(
    event: IpcMainInvokeEvent,
    emojis: Array<{ id: string; name: string; guildName: string; }>,
    customDir?: string,
    size?: number
): Promise<number> {
    let newlyCached = 0;

    for (const emoji of emojis) {
        const result = await cacheEmoji(
            event,
            emoji.id,
            emoji.name,
            emoji.guildName,
            customDir,
            size
        );

        if (result.cached) {
            newlyCached++;
        }
    }

    return newlyCached;
}

/**
 * Initialize the cache directory and populate the in-memory set
 * from existing files on disk.
 */
export async function initCache(
    _: IpcMainInvokeEvent,
    customDir?: string
): Promise<number> {
    const baseDir = resolveBaseDir(customDir);
    ensureDir(baseDir);

    const { readdirSync } = require("original-fs");

    let count = 0;

    try {
        const guildDirs: string[] = readdirSync(baseDir, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);

        for (const guildDir of guildDirs) {
            const fullGuildDir = join(baseDir, guildDir);
            const files: string[] = readdirSync(fullGuildDir);

            for (const file of files) {
                // Extract emoji ID from filename pattern: name-id.png
                const match = file.match(/-(\d+)\.png$/);
                if (match) {
                    cachedEmojiIds.add(match[1]);
                    count++;
                }
            }
        }
    } catch (error) {
        console.error("[MessageEmojiCache] Failed to init cache from disk:", error);
    }

    return count;
}
