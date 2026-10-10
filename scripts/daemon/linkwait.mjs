// Agents wait while a sharing connection is moving to another address, on both sides: the
// joiner's agent (its call would go to a host it can't reach yet) and the host's agents in the
// tabs a joiner shares (they would act while the joiner can't see). A short wait is silent; a
// longer one is said in one plain line in that result. Nothing about what carries the connection.
import { sleep } from "../util.mjs";

export const NOTE_AFTER_MS = 3000; // a wait shorter than this isn't worth a word

// Waits while down() says the connection is away (a name or true), up to max ms, polling every
// `every` ms; stops early when isCurrent() turns false. Resolves to the ms waited.
export async function waitForLink(down, { max, every = 150, isCurrent = () => true } = {}) {
  const from = Date.now();
  while (down() && isCurrent() && Date.now() - from < max) await sleep(every);
  return Date.now() - from;
}

// The line for a result after a wait worth mentioning ("" otherwise). what: "Alice's connection",
// "the connection to Bob's session".
export const waitedLine = (ms, what) => (ms >= NOTE_AFTER_MS ? `Waited ${Math.round(ms / 1000)} s for ${what} to come back.` : "");
