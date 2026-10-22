// Discord, as a direct message from your own bot (the Handoff page links it: phonelink.mjs):
// Create Message (POST <server>/channels/<dm channel>/messages, JSON) with the bot's token
// (Authorization: Bot <token>, User-Agent: DiscordBot (<url>, <version>) as Discord asks), content
// up to 2000 characters (a longer one is refused, never cut), embeds suppressed (flags
// SUPPRESS_EMBEDS, 1 << 2: no link preview) and no mentions parsed. Discord and you see the
// message. The DM linked from the Handoff page is told how to answer an approval it may answer
// (message.answer: a typed "approve <code>"); interactions (buttons) would need a public endpoint.
import { readFileSync } from "node:fs";
import { fieldOf, secretFor } from "./channel.mjs";
import { DISCORD_API, DISCORD_ID, DISCORD_TOKEN, linkedDiscord } from "./linked.mjs";

const TOKEN_RULE = { secret: true, required: true, pattern: DISCORD_TOKEN, what: "a Discord bot token" };
const ID_RULE = { secret: true, required: true, pattern: DISCORD_ID, what: "a Discord channel id (a number)" };
const FIELDS = {
  server: { address: true, default: DISCORD_API },
  tokenSecret: TOKEN_RULE,
  channelSecret: ID_RULE,
};
const SUPPRESS_EMBEDS = 1 << 2;
const CONTENT_MAX = 2000;
let version = "";
try { version = String(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version || ""); } catch {}
// The User-Agent Discord asks a bot for.
export const DISCORD_AGENT = `DiscordBot (https://pairbrowse.com, ${/^[\w.+-]{1,32}$/.test(version) ? version : "0"})`;
export const discordHeaders = (token) => ({ authorization: `Bot ${token}`, "user-agent": DISCORD_AGENT, "content-type": "application/json" });

export default {
  type: "discord-dm",
  fields: FIELDS,
  create(channel, { secret, post, messageText }) {
    const server = String(fieldOf(channel, FIELDS, "server")).replace(/\/+$/, "");
    return {
      type: "discord-dm",
      describe: () => `discord-dm (${channel.channelSecret})`,
      async send(message) {
        const token = secretFor(secret, channel.tokenSecret, TOKEN_RULE);
        if (token.error) return { ok: false, error: token.error };
        const id = secretFor(secret, channel.channelSecret, ID_RULE);
        if (id.error) return { ok: false, error: id.error };
        const typed = message.kind === "approval" && message.answer === true && linkedDiscord(channel);
        const { title, text } = messageText(message, { reply: typed ? "typed" : false });
        const content = `**${title}**\n${text}`;
        if (content.length > CONTENT_MAX) return { ok: false, error: "the message is over Discord's 2000 characters" };
        const body = { content, flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } };
        const r = await post(`${server}/channels/${id.value}/messages`, JSON.stringify(body), { headers: discordHeaders(token.value) });
        return { ...r, link: !!message.link };
      },
    };
  },
};
