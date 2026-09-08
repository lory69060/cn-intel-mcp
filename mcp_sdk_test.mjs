import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.TOKEN;
const transport = new StreamableHTTPClientTransport(
  new URL("https://cn-intel-mcp.lory69060.workers.dev/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: "sdk-test", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map(t => t.name).join(", "));
const res = await client.callTool({ name: "get_track_record", arguments: { include_signals: false } });
const data = JSON.parse(res.content[0].text);
console.log("track_record:", JSON.stringify(data.summary));
const res2 = await client.callTool({ name: "read_signal_board", arguments: { industry: "低空经济/eVTOL", limit: 2 } });
const d2 = JSON.parse(res2.content[0].text);
console.log("signal_board 低空:", d2.total, "条");
await client.close();
console.log("✅ SDK 客户端端到端测试通过");
