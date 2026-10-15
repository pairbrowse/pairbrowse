// PairBrowse's own tools (and browser_drag, browser_wait_for, which it runs itself), by family:
// one connection's table. Each returns { text, error, url } (or { content } with a picture).
import { createSimpleTools } from "./simple.mjs";
import { createRunTool } from "./run.mjs";
import { createStatusTool } from "./status.mjs";
import { createScrollTool } from "./scroll.mjs";
import { createDragTool } from "./drag.mjs";
import { createWaitForTool } from "./wait-for.mjs";
import { createClickAtTool } from "./click-at.mjs";

export function createOwnTools(conn, api) {
  const { pairbrowse_session, pairbrowse_facts, pairbrowse_liveview, pairbrowse_record, pairbrowse_invite, pairbrowse_join, pairbrowse_upload } = createSimpleTools(conn, api);
  const ownTools = {
    pairbrowse_session, pairbrowse_facts, pairbrowse_liveview, pairbrowse_record, pairbrowse_invite, pairbrowse_join,
    ...createRunTool(conn, api),
    ...createStatusTool(conn, api),
    pairbrowse_upload,
    ...createScrollTool(conn, api),
    ...createDragTool(conn, api),
    ...createWaitForTool(conn, api),
    ...createClickAtTool(conn, api),
    ...api.testTools, // only with a test switch set (daemon.mjs); empty otherwise
  };
  return { ownTools };
}
