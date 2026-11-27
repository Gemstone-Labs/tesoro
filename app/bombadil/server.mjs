// Runs from the isolated Next root with empty-chain reads and read-only bridge quotes.
import { createServer } from "node:http";
import next from "next";
import ws from "next/dist/compiled/ws/index.js";

const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL);
const app = next({ dev: false, hostname: origin.hostname, port: Number(origin.port) });
const handle = app.getRequestHandler();
const context = { slot: 1 };

function rpc({ id, method, params = [] }, path) {
  let result;
  switch (method) {
    case "getGenesisHash": result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; break;
    case "eth_chainId": result = path.endsWith("/hoodi") ? "0x88bb0" : "0x3e6"; break;
    case "getProgramAccounts": result = params[1]?.withContext ? { context, value: [] } : []; break;
    case "getAccountInfo": result = { context, value: null }; break;
    case "getMultipleAccounts": result = { context, value: params[0].map(() => null) }; break;
    case "getBalance": result = { context, value: 0 }; break;
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported fixture RPC: ${method}` } };
  }
  return { jsonrpc: "2.0", id, result };
}

const server = createServer(async (req, res) => {
  const { pathname: path, searchParams } = new URL(req.url, origin);
  // A real redeem quote simulates a LayerZero transaction with the relayer. The public price
  // endpoint reads Coinbase/CoinGecko. Neither dependency belongs in a guest UI run.
  if (req.method === "GET" && path === "/api/eth-bridge") {
    const quote = searchParams.get("quote") === "redeem"
      ? { feeLamports: "2000000" }
      : { priceMicroUsd: searchParams.get("asset") === "HYPE" ? "25000000" : "3000000000", live: false };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(quote));
    return;
  }
  if (path.startsWith("/fixture/")) {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && ["/fixture/solana", "/fixture/hoodi", "/fixture/hyperevm"].includes(path)) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      res.end(JSON.stringify(Array.isArray(data) ? data.map(call => rpc(call, path)) : rpc(data, path)));
    } else if (req.method === "POST" && ["/fixture/rest/v1/rpc/recent_wins", "/fixture/rest/v1/rpc/studio_featured"].includes(path)) {
      res.end("[]");
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Unknown fixture: ${path}` }));
    }
    return;
  }
  await handle(req, res);
});

// web3.js opens subscriptions on the RPC HTTP port + 1. An empty chain has no change events.
const subscriptions = new ws.WebSocketServer({ host: origin.hostname, port: Number(origin.port) + 1 });
subscriptions.on("connection", socket => {
  let nextId = 0;
  socket.on("message", message => {
    const { id, method } = JSON.parse(message);
    if (id == null) return; // heartbeat notification
    const reply = method === "accountSubscribe" ? { result: ++nextId }
      : method === "accountUnsubscribe" ? { result: true }
      : { error: { code: -32601, message: `Unsupported subscription: ${method}` } };
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
  });
});

// The app's instrumentation calls getGenesisHash and eth_chainId during prepare().
server.listen(Number(origin.port), origin.hostname, async () => {
  await app.prepare();
  console.log("Tesoro fixture ready");
});
