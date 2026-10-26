// The Telegram Bot API calls the Handoff page uses (daemon/phonelink.mjs): getMe (the token works,
// the bot's name), getUpdates (a long poll, only while a link waits, an approval the chat may
// answer waits or /watch is on), sendMessage, answerCallbackQuery, editMessageReplyMarkup and
// setMyCommands (/watch in the bot's menu). Each is one bounded
// request through notify/post.mjs httpsJson (its own agents, no proxy, no redirect, answer capped).
// No result or error holds the token or an answer's text: only Telegram's status and our own words.
import { httpsJson } from "../notify/post.mjs";

export const POLL_SECONDS = 25;
const USERNAME = /^[A-Za-z0-9_]{3,64}$/;

// base: the Bot API's address (https://api.telegram.org; a loopback stand-in in tests).
export function createTelegramApi({ base, request = httpsJson, pollSeconds = POLL_SECONDS }) {
  const root = String(base).replace(/\/+$/, "");
  const call = (token, method, body = {}, timeoutMs = 10_000) => request(`${root}/bot${token}/${method}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, timeoutMs });
  return {
    pollSeconds,
    // { bot: "@name" } or { error } (a sentence for the page).
    async getMe(token) {
      const r = await call(token, "getMe");
      if (r.status === 401 || r.status === 404) return { error: "Telegram didn't accept this token. Copy it again from @BotFather (or make a new one there with /token)." };
      if (!r.ok) return { error: `Telegram didn't answer (${r.error}). Check this computer's connection, then try again.` };
      const name = r.json?.result?.username;
      if (r.json?.ok !== true || r.json?.result?.is_bot !== true || typeof name !== "string" || !USERNAME.test(name)) return { error: "Telegram's answer wasn't a bot's. Copy the token again from @BotFather." };
      return { bot: `@${name}` };
    },
    // { ok, updates } or { ok: false, status, error, retryAfter (ms, on a 429) }.
    async getUpdates(token, offset) {
      const r = await call(token, "getUpdates", { ...(offset ? { offset } : {}), timeout: pollSeconds, limit: 50, allowed_updates: ["message", "callback_query"] }, (pollSeconds + 10) * 1000);
      if (r.ok && r.json?.ok === true && Array.isArray(r.json.result)) return { ok: true, updates: r.json.result };
      const after = Number(r.json?.parameters?.retry_after);
      return { ok: false, status: r.status || 0, error: r.error || "not an answer", ...(r.status === 429 && after > 0 ? { retryAfter: Math.min(after, 300) * 1000 } : {}) };
    },
    sendMessage: (token, chatId, text) => call(token, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), link_preview_options: { is_disabled: true } }),
    answerCallbackQuery: (token, id, text) => call(token, "answerCallbackQuery", { callback_query_id: id, text: String(text).slice(0, 200) }),
    removeKeyboard: (token, chatId, messageId) => call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    // The bot's command menu (the menu button next to the chat's text box): /watch while it is on.
    setCommands: (token, commands) => call(token, "setMyCommands", { commands, scope: { type: "all_private_chats" } }),
  };
}
