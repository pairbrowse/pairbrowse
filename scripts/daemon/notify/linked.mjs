// The names a linked app's credentials and ids live under (reserved PAIRBROWSE_ secrets in
// secrets.env), the patterns they are checked by, and the production addresses. Shared by the
// Handoff page's helper part (daemon/phonelink.mjs) and the senders here.
import { RESERVED_PREFIX } from "../../rules/secrets.mjs";

// Secrets in secrets.env, never environment variables: the reserved prefix and HANDOFF_<APP>_<WHAT>.
const named = (rest) => `${RESERVED_PREFIX}HANDOFF_${rest}`;
export const TELEGRAM = { token: named("TELEGRAM_TOKEN"), chat: named("TELEGRAM_CHAT") };
export const DISCORD = { token: named("DISCORD_TOKEN"), channel: named("DISCORD_CHANNEL"), user: named("DISCORD_USER") };
export const TELEGRAM_API = "https://api.telegram.org";
export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
// A Telegram bot token (123456:ABC...), as @BotFather gives it.
export const TELEGRAM_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;
// A Discord bot token: three base64url parts joined by dots.
export const DISCORD_TOKEN = /^[A-Za-z0-9_-]{20,100}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,100}$/;
// A Discord id (a snowflake).
export const DISCORD_ID = /^\d{15,21}$/;
// The codes: an alphabet without 0/O and 1/I, a link code PB- and 6 of them, an approval's 4.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_CODE = /^PB-[A-HJ-NP-Z2-9]{6}$/;
export const APPROVAL_CODE = /^[A-HJ-NP-Z2-9]{4}$/;
// Whether a channel entry is the one linking made (answers are read only there).
export const linkedTelegram = (channel) => channel?.tokenSecret === TELEGRAM.token && channel?.chatSecret === TELEGRAM.chat;
export const linkedDiscord = (channel) => channel?.tokenSecret === DISCORD.token && channel?.channelSecret === DISCORD.channel;
