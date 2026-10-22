// Telegram: the Bot API's sendMessage (POST <server>/bot<token>/sendMessage, JSON) to the chat
// in chatSecret, plain text (no parse_mode: nothing in it is read as markup), link previews off
// (link_preview_options.is_disabled; a previewer that fetches anyway only sees the landing page,
// B-AP1). server: a Bot API server of your own (default https://api.telegram.org). Bot messages
// are not end-to-end encrypted: Telegram's servers and the chat's members see them.
// The chat linked from the Handoff page (linked.mjs linkedTelegram) gets an approval it
// may answer (message.answer) with Approve and Deny buttons (callback_data pb:a:<code>,
// pb:d:<code>); any other chat is told to answer in PairBrowse.
import { fieldOf, secretFor } from "./channel.mjs";
import { linkedTelegram, TELEGRAM_TOKEN } from "./linked.mjs";

const TOKEN_RULE = { secret: true, required: true, pattern: TELEGRAM_TOKEN, what: "a bot token (123456:ABC...)" };
const CHAT_RULE = { secret: true, required: true, pattern: /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/, what: "a chat id (a number) or @channelname" };
const FIELDS = {
  server: { address: true, default: "https://api.telegram.org" },
  tokenSecret: TOKEN_RULE,
  chatSecret: CHAT_RULE,
};

export default {
  type: "telegram",
  fields: FIELDS,
  create(channel, { secret, post, messageText }) {
    const server = String(fieldOf(channel, FIELDS, "server")).replace(/\/+$/, "");
    return {
      type: "telegram",
      describe: () => `telegram (${channel.chatSecret})`,
      async send(message) {
        const token = secretFor(secret, channel.tokenSecret, TOKEN_RULE);
        if (token.error) return { ok: false, error: token.error };
        const chat = secretFor(secret, channel.chatSecret, CHAT_RULE);
        if (chat.error) return { ok: false, error: chat.error };
        const buttons = message.kind === "approval" && message.answer === true && linkedTelegram(channel);
        const { title, text } = messageText(message, { reply: buttons ? "buttons" : false });
        const body = { chat_id: chat.value, text: `${title}\n${text}`, link_preview_options: { is_disabled: true } };
        if (buttons) body.reply_markup = { inline_keyboard: [[{ text: "Approve", callback_data: `pb:a:${message.code}` }, { text: "Deny", callback_data: `pb:d:${message.code}` }]] };
        const r = await post(`${server}/bot${token.value}/sendMessage`, JSON.stringify(body), { headers: { "content-type": "application/json" } });
        return { ...r, link: !!message.link };
      },
    };
  },
};
