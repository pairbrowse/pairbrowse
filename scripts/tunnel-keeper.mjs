// The tunnel keeper's entry (tunnels/keeper.mjs): a fixed path, since tunnels/quick.mjs starts it
// by this name and adopts keepers an older helper started by it.
// Usage: node tunnel-keeper.mjs <cloudflared> <port> <heartbeat file> <grace ms>
import { runKeeper } from "./tunnels/keeper.mjs";

runKeeper(process.argv.slice(2));
