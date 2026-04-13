# RichNotify Media Fixes Design

**Date:** 2026-04-13
**Status:** Approved
**Scope:** `src/userplugins/richNotify/index.ts` (primary), QML-side debug logging (temporary, out-of-tree)

## Problem

Three bugs in the RichNotify plugin prevent QuickShell from rendering Discord notification media correctly:

1. **Custom emoji render as `:emojiname:` text** instead of inline images in toasts and the notification center.
2. **Stickers don't show up at all**, despite the plugin having extraction logic and the QML renderer having sticker display components.
3. **Image attachments, sticker images, and embed images never animate** even when the source is an animated GIF. They render as static first-frame images.

Unicode emoji work fine. The DBus hint transport pipeline is functional (proven by `x-quickshell-images` and `x-quickshell-embed` hints arriving and rendering correctly as static content).

## Approach: Debug-First, Minimal Fixes

The existing architecture is sound. The plugin extracts media metadata, serializes it as `x-quickshell-*` DBus hints, and QuickShell's QML components consume them. Something specific is breaking in the data flow for emoji and stickers, and the animation issue is a known Qt format limitation. We debug to find the exact root causes, then apply the smallest possible fixes.

## Phase 1: Debug Logging

Add temporary `Logger.info` calls to the `RPC_NOTIFICATION_CREATE` flux handler in `index.ts`. Log once per notification, before any extraction:

- `message` presence (null vs object)
- `message.content` raw value (first 200 chars)
- `body` raw value (first 200 chars)
- `message.stickerItems` full array or null
- `message.attachments` count and first item's `content_type` + `proxy_url`
- `message.embeds` count and first item's image/thumbnail URLs

After extraction, log:

- `emojis` array length and first entry
- `sticker` result (null or object)
- `bodyHtml` first 200 chars

On the QML side (out-of-tree, in `~/.config/quickshell`), add temporary `console.log` calls in `Notifs.qml`'s `Component.onCompleted` to confirm hint values arrive.

Remove all debug logging after root causes are confirmed and fixes are shipped.

## Phase 2: Emoji Fix

Root cause will be one of:

### If `message.content` has raw `<a:name:id>` syntax

The extraction pipeline works. The bug is in transport or QML-side parsing. Check:

- Whether `x-quickshell-emojis` hint value arrives in QML
- Whether bodyHtml string survives GVariant escaping with `<>` intact

### If `message.content` is empty/missing and `body` has `:name:` format

Cannot extract emoji from `:name:` alone (no ID for CDN URL). Options:

- Use `EmojiStore` from `@webpack/common` to look up custom emoji by name to get the ID
- Switch content selection from `??` (nullish coalescing) to `||` so empty string falls through to `body`, if body has raw syntax

### If both fields have `:name:` format

`EmojiStore` lookup is the only path to get CDN URLs from names.

Fix will be a few lines in `extractEmojis` or the content selection logic. No architectural changes.

## Phase 3: Sticker Fix

Root cause will be one of:

### If `stickerItems` is undefined in the flux event

Use `MessageStore.getMessage(channelId, messageId)` from `@webpack/common` to get the full message object. Timing risk is low since the notification fires after the message is received and stored.

### If `stickerItems` exists but the URL is wrong

Verify current sticker URL format. Discord may require different CDN host or query parameters. Test against a known sticker ID.

### If data reaches QML but rendering fails

The QML sticker hint parse has a try/catch that silently swallows errors. Add `console.warn` on the QML side to confirm.

Fix will be a store lookup fallback, a URL format correction, or both.

## Phase 4: Animation Fix

Qt's `AnimatedImage` reliably animates GIF but not animated WebP. Discord's CDN increasingly serves WebP by default. This is the most confident diagnosis without needing debug logs.

### Attachments

Currently using `proxy_url` raw. Fix: append `?format=gif` to Discord CDN URLs when `content_type` indicates animation (`image/gif` or `image/webp`).

### Embed images

Same CDN issue. If the URL is a Discord CDN URL (`cdn.discordapp.com` or `media.discordapp.net`), append `?format=gif`. External URLs are left as-is.

### Stickers

Format type 4 already gets `.gif`. Format type 2 (APNG) currently gets `.png` which won't animate in Qt. Try requesting `.gif` for APNG stickers since Discord can serve stickers in multiple formats.

### Emoji

Already using `.gif` for animated, `.webp` for static. No change needed.

Implementation: a small URL-rewriting helper that ensures Discord CDN URLs request GIF format when animation is expected.

## Out of Scope

- Changes to QuickShell QML rendering components (they handle data correctly when they receive it)
- Changes to `native.ts` or DBus transport (hint pipeline works)
- New settings or configuration options
- Refactoring of existing architecture
- Lottie sticker support (format_type 3, unsupported in QML)
- Video attachment support

## Testing

Manual verification. Trigger notifications with each content type and verify rendering in QuickShell:

- Message with custom emoji (animated and static)
- Sticker-only message (PNG, APNG, GIF format types)
- Message with GIF attachment
- Message with embed containing animated image
- Message with multiple content types combined

Check Equicord console for debug output during investigation phase.
