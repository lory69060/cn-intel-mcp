/**
 * cn-intel-mcp — 中国硬科技供应链信息差 MCP Server（Cloudflare Workers 远程版）
 *
 * 数据源：GitHub Pages 公网 JSON（GEO 站点），Worker 只做薄代理 + 判断层逻辑
 *   - 信号看板: https://lory69060.github.io/cn-intel-board/signal-board-structured.json
 *   - 中报追踪: https://lory69060.github.io/cn-intel-board/data/earnings-tracker-2026H1.json
 *   - 文章清单: https://lory69060.github.io/cn-intel-board/llms.txt
 *
 * 协议：MCP Streamable HTTP（createMcpHandler，官方 Agents SDK 无状态方案）
 *
 * 鉴权四层（2026-10-20 重构，对齐线上已部署行为）：
 *   admin  — env MCP_ACCESS_TOKEN（/stats、/admin 也仅此层）
 *   pro    — KV token 池（SHA-256 哈希存储），日限 10000
 *   free   — KV token 池，日限 100
 *   anon   — /mcp 全只读工具匿名开放，tools/call 日限 100（KV key rl:anon:YYYY-MM-DD）
 *   无效/过期 token 一律 401（不静默降级为匿名）
 *
 * 附加路由：/.well-known/glama.json（Glama claim，verified 基线；固化防 deploy 冲掉）
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const BASE = "https://lory69060.github.io/cn-intel-board";
const SIGNAL_URL = `${BASE}/signal-board-structured.json`;
const EARNINGS_URL = `${BASE}/data/earnings-tracker-2026H1.json`;
const LLMS_URL = `${BASE}/llms.txt`;
const ARTICLES_PREFIX = `${BASE}/articles/`;

// ─── 缓存工具（300s TTL，避免频繁打 GitHub Pages）────────────
async function cachedFetch(url: string): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(url);
  if (cached) return cached;
  const res = await fetch(url, { headers: { "User-Agent": "cn-intel-mcp-worker" } });
  if (res.ok) {
    // 300s 过期：信号板每日批量验证后不会永久陈旧（旧版无 TTL，缓存不失效）
    // workers-types 的 Cache.put 缺第三参类型，实际运行时支持 expirationTtl
    ;(cache.put as (...a: unknown[]) => Promise<void>)(url, res.clone(), { expirationTtl: 300 }).catch(() => {});
  }
  return res;
}

async function fetchJson(url: string): Promise<any> {
  const res = await cachedFetch(url);
  if (!res.ok) throw new Error(`数据源 ${url} 返回 ${res.status}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await cachedFetch(url);
  if (!res.ok) throw new Error(`数据源 ${url} 返回 ${res.status}`);
  return res.text();
}

// ─── Glama claim 路由（2026-10-12 起固化，deploy 不会冲掉）───
const GLAMA_CLAIM = "glama_claim_w3_Ss-2qR-Viv8QmonNlfXp0CLIhydKc";
const GLAMA_CONNECTOR_URL = "https://glama.ai/mcp/connectors/dev.workers.lory69060.cn-intel-mcp/cn-intel-mcp";

// ─── 行业关键词映射（与本地 Python 版一致）───────────────────
const INDUSTRY_KEYWORDS: Record<string, { 专属: string[]; 通用: string[] }> = {
  "存储/半导体": {
    专属: ["存储", "半导体", "芯片", "HBM", "DRAM", "光刻", "刻蚀", "封装", "CoWoS", "长鑫", "台积电", "北方华创", "中微", "拓荆", "零部件", "耗材", "光刻胶"],
    通用: ["材料", "国产率", "资本支出", "估值", "产能"],
  },
  固态电池: {
    专属: ["固态电池", "硫化物", "硫化锂", "锂金属", "电解质", "隔膜", "电芯", "比亚迪", "国轩", "恩捷", "清陶", "负极"],
    通用: ["上游", "材料", "成本", "电池", "产能", "装车", "订单"],
  },
  "低空经济/eVTOL": {
    专属: ["低空", "eVTOL", "飞行汽车", "无人机", "航电", "亿航", "峰飞", "沃兰特", "御风", "适航"],
    通用: ["电池", "订单", "成本", "整机", "市场"],
  },
  创新药: {
    专属: ["创新药", "医药", "康方", "恒瑞", "GLP", "替尔泊肽", "CDMO", "商保", "医保", "BD交易", "管线", "临床"],
    通用: ["交易", "出海", "支付", "目录"],
  },
};

function detectIndustry(question: string): string | null {
  const q = question.toLowerCase();
  let bestInd: string | null = null;
  let bestScore = 0;
  for (const [ind, kws] of Object.entries(INDUSTRY_KEYWORDS)) {
    let score = 0;
    for (const kw of kws.专属) if (q.includes(kw.toLowerCase())) score += 3;
    for (const kw of kws.通用) if (q.includes(kw.toLowerCase())) score += 1;
    if (score > bestScore) {
      bestInd = ind;
      bestScore = score;
    }
  }
  return bestScore > 0 ? bestInd : null;
}

const STOPWORDS = new Set([
  "什么", "怎么", "如何", "有", "是", "的", "了", "吗", "呢", "谁", "我们",
  "哪些", "一个", "这个", "那个", "散户", "市场", "信息差", "事情", "方面",
]);

function scoreQuestion(question: string, signal: any, detected: string | null): number {
  const q = question.toLowerCase();
  let score = 0;
  const ind = signal.industry || "";
  const text = `${signal.signal || ""} ${signal.basis || ""}`.toLowerCase();

  if (detected) {
    if (ind === detected) score += 6;
    else return 0;
  }

  const cleaned = q.replace(/[？?：:]/g, " ").split(/\s+/);
  for (const w of cleaned) {
    if (w.length >= 2 && !STOPWORDS.has(w) && text.includes(w)) score += 1;
  }
  return score;
}

// ─── llms.txt 解析：文章清单 ─────────────────────────────────
interface ArticleEntry {
  file: string;
  title: string;
  url: string;
}

function parseArticles(llmsTxt: string): ArticleEntry[] {
  const entries: ArticleEntry[] = [];
  for (const line of llmsTxt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ARTICLES_PREFIX)) continue;
    const parts = trimmed.split(" - ");
    const url = parts[0].trim();
    const fileName = decodeURIComponent(url.slice(ARTICLES_PREFIX.length));
    const title = (parts.length > 1 ? parts.slice(1).join(" - ").trim() : fileName).slice(0, 80);
    entries.push({ file: fileName, title, url });
  }
  return entries;
}

// ─── MCP Server 组装 ─────────────────────────────────────────
function createServer() {
  const server = new McpServer({
    name: "cn-intel-mcp",
    version: "0.1.0",
  });

  // 1. read_signal_board
  server.registerTool(
    "read_signal_board",
    {
      description:
        "读取信号信息差看板，返回结构化 JSON，包含 📊 高信息差信号（真信息差）。每条信号含 predicted_on/verify_by/verify_event/result 验证记录字段。",
      inputSchema: {
        industry: z.string().optional().describe("按行业筛选，如 '存储/半导体'、'固态电池'、'低空经济/eVTOL'、'创新药'；不填则返回全部"),
        limit: z.number().int().optional().describe("返回条数上限，默认全部"),
        result: z.string().optional().describe("按验证结果筛选：'待验证'/'已兑现'/'部分兑现'/'落空'/'推迟'；不填则返回全部"),
      },
    },
    async ({ industry, limit, result }) => {
      const data = await fetchJson(SIGNAL_URL);
      let signals = data.signals || [];
      if (industry) signals = signals.filter((s: any) => (s.industry || "").includes(industry));
      if (result) signals = signals.filter((s: any) => s.result === result);
      if (limit) signals = signals.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: signals.length, signals, source: SIGNAL_URL }, null, 2),
          },
        ],
      };
    }
  );

  // 2. read_earnings_tracker
  server.registerTool(
    "read_earnings_tracker",
    {
      description:
        "读取中报信号验证追踪表：我们信号板预测的公司 vs 实际披露业绩 vs 验证状态（验证/部分验证/待验证）",
      inputSchema: {
        industry: z.string().optional().describe("按行业筛选，如 '存储/半导体'、'储能/电池'；不填则返回全部"),
        status: z.string().optional().describe("按验证状态筛选：'验证'/'部分验证'/'待验证'；不填则返回全部"),
      },
    },
    async ({ industry, status }) => {
      const data = await fetchJson(EARNINGS_URL);
      let companies = data.tracked_companies || [];
      if (industry) companies = companies.filter((c: any) => (c.industry || "").includes(industry));
      if (status) companies = companies.filter((c: any) => (c.verification || {}).result === status);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: companies.length, tracked_companies: companies, source: EARNINGS_URL }, null, 2),
          },
        ],
      };
    }
  );

  // 3. get_track_record
  server.registerTool(
    "get_track_record",
    {
      description:
        "读取信号验证记录（track record）：命中率、已验证/待验证统计、每条信号从 predicted_on 到 verify_by 的结果。这是唯一用时间积累的资产——判断层的命中历史，LLM 无法生成。Use when: 评估信号板可信度、查某行业历史命中率、复盘已兑现/落空案例。Use instead: 要当前信号清单用 read_signal_board；问判断层问题用 ask_edge；查财报追踪用 read_earnings_tracker。",
      inputSchema: {
        industry: z.string().optional().describe("按行业筛选命中率统计；不填则返回全量"),
        include_signals: z.boolean().optional().describe("是否包含每条信号的明细，默认 true"),
      },
    },
    async ({ industry, include_signals }) => {
      const data = await fetchJson(SIGNAL_URL);
      let signals: any[] = data.signals || [];
      if (industry) signals = signals.filter((s: any) => (s.industry || "").includes(industry));

      const total = signals.length;
      const pending = signals.filter((s) => s.result === "待验证");
      const verified = signals.filter((s) => ["已兑现", "部分兑现", "落空"].includes(s.result));
      const hit = verified.filter((s) => ["已兑现", "部分兑现"].includes(s.result));
      const miss = verified.filter((s) => s.result === "落空");
      const delayed = signals.filter((s) => s.result === "推迟");

      const byIndustry: Record<string, any> = {};
      for (const s of signals) {
        const ind = s.industry || "未知";
        const b = (byIndustry[ind] ||= { total: 0, verified: 0, hit: 0, pending: 0 });
        b.total += 1;
        if (s.result === "待验证") b.pending += 1;
        else if (["已兑现", "部分兑现", "落空"].includes(s.result)) {
          b.verified += 1;
          if (["已兑现", "部分兑现"].includes(s.result)) b.hit += 1;
        }
      }

      const result: any = {
        summary: {
          total_signals: total,
          pending: pending.length,
          verified: verified.length,
          hit: hit.length,
          miss: miss.length,
          delayed: delayed.length,
          hit_rate: verified.length ? Math.round((hit.length / verified.length) * 1000) / 1000 : null,
          note: "hit_rate = 已兑现+部分兑现 / 已验证；待验证不计入分母",
        },
        by_industry: byIndustry,
        source: SIGNAL_URL,
      };
      if (include_signals !== false) result.signals = signals;

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // 4. ask_edge
  server.registerTool(
    "ask_edge",
    {
      description:
        "问答式信息差查询：Agent 用自然语言问产业问题，返回最相关的信号+信息差依据。区别于数据 API——返回的是判断层（what it means），不是原始数据。",
      inputSchema: {
        question: z.string().describe("自然语言问题，如 '固态电池上游材料谁有信息差？'、'存储板块有什么散户不知道的？'"),
        limit: z.number().int().optional().describe("返回条数上限，默认 5"),
      },
    },
    async ({ question, limit }) => {
      if (!question) throw new Error("question 必填");
      const n = limit ?? 5;
      const data = await fetchJson(SIGNAL_URL);
      const signals: any[] = data.signals || [];
      const detected = detectIndustry(question);

      const scored = signals
        .map((s) => ({ s, score: scoreQuestion(question, s, detected) }))
        .sort((a, b) => b.score - a.score);
      let top = scored.filter((x) => x.score > 0).slice(0, n).map((x) => x.s);

      if (top.length === 0) {
        if (detected) top = signals.filter((s) => s.industry === detected).slice(0, n);
        else top = signals.slice(0, n);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                question,
                detected_industry: detected,
                total_matched: top.length,
                signals: top,
                note: "返回的是判断层（信号+信息差依据），不是原始数据——这是与 akshare/新浪等数据源的本质区别",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 5. list_articles
  server.registerTool(
    "list_articles",
    {
      description:
        "列出中国硬科技供应链研究文章清单（标题/主题/链接），供 Agent 发现可引用的深度内容。",
      inputSchema: {
        topic: z.string().optional().describe("按主题筛选，如 '存储'、'AI'、'冷链'、'固态电池'；不填则返回全部"),
        limit: z.number().int().optional().describe("返回条数上限，默认 20"),
      },
    },
    async ({ topic, limit }) => {
      const llmsTxt = await fetchText(LLMS_URL);
      let articles = parseArticles(llmsTxt);
      if (topic) articles = articles.filter((a) => a.file.includes(topic) || a.title.includes(topic));
      articles = articles.slice(0, limit ?? 20);
      return {
        content: [
          { type: "text", text: JSON.stringify({ total: articles.length, articles }, null, 2) },
        ],
      };
    }
  );

  // 6. read_article
  server.registerTool(
    "read_article",
    {
      description:
        "读取指定研究文章全文（中文），供 Agent 引用分析。文章是我们对产业的一手调查笔记（信息差视角）。",
      inputSchema: {
        title: z.string().describe("文章标题或文件名（可用 list_articles 查看），支持模糊匹配"),
      },
    },
    async ({ title }) => {
      if (!title) throw new Error("title 必填");
      const llmsTxt = await fetchText(LLMS_URL);
      const articles = parseArticles(llmsTxt);
      const match = articles.find(
        (a) => a.file.includes(title) || a.title.includes(title) || title.includes(a.file.replace(/\.md$/, ""))
      );
      if (!match) {
        throw new Error(`未找到文章: ${title}（可用 list_articles 查看清单）`);
      }
      const content = await fetchText(match.url);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { file: match.file, content: content.slice(0, 8000), truncated: content.length > 8000 },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

// ─── Token 权限体系（2026-08-16 三层 → 2026-10-20 四层）──────
// admin（env MCP_ACCESS_TOKEN，全量）/ pro（付费）/ free（限频）/ anon（/mcp 匿名开放，tools/call 限频）
// 存储：KV 只存 token 的 SHA-256 哈希，不存明文
const FREE_DAILY_LIMIT = 100;
const PRO_DAILY_LIMIT = 10000;
const ANON_DAILY_LIMIT = 100; // 匿名开放层日限（key: rl:anon:YYYY-MM-DD）
const PAID_TOOLS: string[] = []; // 未来付费工具白名单（实时信号/深度分析等，暂空；anon 层不可用）

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface TokenRecord {
  tier: "free" | "pro";
  name: string;
  created: string;
  expires?: string;
  limit?: number; // 自定义日限额（覆盖默认）
}

// 四层访问判定：admin / token(free|pro) / anon / null（= 提供了无效或过期 token，401）
type Access =
  | { kind: "admin" }
  | { kind: "token"; tier: "free" | "pro"; hash: string; limit: number }
  | { kind: "anon" };

async function resolveAccess(env: any, authHeader: string): Promise<Access | null> {
  // 1) admin（env MCP_ACCESS_TOKEN）
  if (env.MCP_ACCESS_TOKEN && authHeader === `Bearer ${env.MCP_ACCESS_TOKEN}`) {
    return { kind: "admin" };
  }
  // 2) 带了 token：无效/过期/记录损坏 → 401（绝不静默降级为匿名）
  const provided = authHeader.startsWith("Bearer ") && authHeader.slice(7).trim().length > 0;
  if (provided) {
    if (!env.MCP_TOKENS) return null;
    const token = authHeader.slice(7).trim();
    const hash = await sha256hex(token);
    const raw = await env.MCP_TOKENS.get(`token:${hash}`);
    if (raw) {
      try {
        const rec: TokenRecord = JSON.parse(raw);
        if (!(rec.expires && Date.now() > new Date(rec.expires).getTime())) {
          return {
            kind: "token",
            tier: rec.tier,
            hash,
            limit: rec.limit ?? (rec.tier === "pro" ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT),
          };
        }
      } catch {
        /* 记录损坏 → 401 */
      }
    }
    return null;
  }
  // 3) 无 token → 匿名开放层（/mcp 全只读工具，tools/call 日限 ANON_DAILY_LIMIT）
  return { kind: "anon" };
}

async function rateLimit(env: any, hash: string, limit: number): Promise<boolean> {
  if (!env.MCP_TOKENS) return true;
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${hash}:${day}`;
  const cur = parseInt((await env.MCP_TOKENS.get(key)) || "0");
  if (cur >= limit) return false;
  env.MCP_TOKENS.put(key, String(cur + 1), { expirationTtl: 172800 }).catch(() => {});
  return true;
}

function json(res: unknown, status = 200): Response {
  return new Response(JSON.stringify(res, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Worker 入口 ─────────────────────────────────────────────
// 用量统计：每次 tools/call 记一笔到 KV（免费额度内）
async function recordUsage(env: any, tool: string) {
  if (!env.MCP_STATS) return;
  try {
    const total = parseInt((await env.MCP_STATS.get("total")) || "0");
    await env.MCP_STATS.put("total", String(total + 1));
    const key = `tool:${tool}`;
    const prev = parseInt((await env.MCP_STATS.get(key)) || "0");
    await env.MCP_STATS.put(key, String(prev + 1));
  } catch {
    /* 统计失败不影响主流程 */
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authHeader = request.headers.get("Authorization") || "";

    // 健康检查
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ name: "cn-intel-mcp", status: "ok", endpoint: "/mcp", tools: 6 });
    }

    // Glama claim 路由（目录平台核验所有权）
    if (url.pathname === "/.well-known/glama.json") {
      return json({
        claim: GLAMA_CLAIM,
        url: GLAMA_CONNECTOR_URL,
        verified: true,
      });
    }

    // 用量统计（admin）
    if (url.pathname === "/stats") {
      if (!env.MCP_ACCESS_TOKEN || authHeader !== `Bearer ${env.MCP_ACCESS_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.MCP_STATS) return json({ error: "stats 未启用" }, 500);
      const list = await env.MCP_STATS.list({ prefix: "" });
      const stats: Record<string, number> = {};
      for (const k of list.keys) {
        stats[k.name] = parseInt((await env.MCP_STATS.get(k.name)) || "0");
      }
      return json({ stats });
    }

    // 管理端点（admin）：token 签发/列表/吊销
    if (url.pathname.startsWith("/admin")) {
      if (!env.MCP_ACCESS_TOKEN || authHeader !== `Bearer ${env.MCP_ACCESS_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.MCP_TOKENS) return json({ error: "tokens 未启用" }, 500);

      // GET /admin/tokens — 列表（不含明文 token）
      if (url.pathname === "/admin/tokens" && request.method === "GET") {
        const list = await env.MCP_TOKENS.list({ prefix: "token:" });
        const tokens = [];
        for (const k of list.keys) {
          const rec = JSON.parse((await env.MCP_TOKENS.get(k.name)) || "{}");
          tokens.push({ id: k.name.slice(6), name: rec.name, tier: rec.tier, created: rec.created, expires: rec.expires || null, limit: rec.limit ?? null });
        }
        return json({ total: tokens.length, tokens });
      }

      // POST /admin/tokens — 签发（返回明文 token，仅此一次）
      if (url.pathname === "/admin/tokens" && request.method === "POST") {
        const body: any = await request.json().catch(() => null);
        if (!body?.name) return json({ error: "name 必填" }, 400);
        const tier = body.tier === "pro" ? "pro" : "free";
        const raw = `cnintel_${tier}_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
        const hash = await sha256hex(raw);
        const rec: TokenRecord = {
          tier,
          name: String(body.name),
          created: new Date().toISOString(),
          expires: body.expires || undefined,
          limit: body.limit || undefined,
        };
        await env.MCP_TOKENS.put(`token:${hash}`, JSON.stringify(rec));
        return json({ ok: true, token: raw, tier, name: rec.name, expires: rec.expires || null, limit: rec.limit ?? null }, 201);
      }

      // POST /admin/tokens/revoke — 吊销 {token}
      if (url.pathname === "/admin/tokens/revoke" && request.method === "POST") {
        const body: any = await request.json().catch(() => null);
        if (!body?.token) return json({ error: "token 必填" }, 400);
        const hash = await sha256hex(String(body.token));
        await env.MCP_TOKENS.delete(`token:${hash}`);
        return json({ ok: true, revoked: true });
      }

      return json({ error: "not found" }, 404);
    }

    // MCP 端点
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    // Token 解析：header Bearer 优先，query ?token= 兜底（兼容 smithery 等目录平台的 query 注入）
    let effectiveAuth = authHeader;
    if (!effectiveAuth) {
      const qToken = url.searchParams.get("token");
      if (qToken) effectiveAuth = `Bearer ${qToken}`;
    }
    const access = await resolveAccess(env, effectiveAuth);
    if (!access) return new Response("Unauthorized", { status: 401 });

    // 读取 body 做权限/限频/统计（仅 POST JSON；GET/SSE 无 body 跳过）
    let bodyText: string | null = null;
    try {
      if (request.method === "POST") bodyText = await request.clone().text();
    } catch {
      /* ignore */
    }
    if (bodyText) {
      try {
        const body = JSON.parse(bodyText);
        if (body?.method === "tools/call") {
          const tool = body?.params?.name;
          if (tool) {
            // 付费工具白名单校验（anon 层不可用；PAID_TOOLS 暂空，未来 2-3 个深度工具回填）
            const canUsePaid =
              access.kind === "admin" || (access.kind === "token" && access.tier === "pro");
            if (PAID_TOOLS.includes(tool) && !canUsePaid) {
              return json({ error: "该工具需要 Pro 套餐（contact: lory69060@hotmail.com）" }, 403);
            }
            // 限频（admin 不限；anon 层按日 100 次）
            if (access.kind === "token" || access.kind === "anon") {
              const ok = await rateLimit(
                env,
                access.kind === "anon" ? "anon" : access.hash,
                access.kind === "anon" ? ANON_DAILY_LIMIT : access.limit
              );
              if (!ok) {
                return new Response("Rate limit exceeded（今日调用次数已用完）", { status: 429, headers: { "Retry-After": "3600" } });
              }
            }
            // 用量统计
            if (env.MCP_STATS) ctx.waitUntil(recordUsage(env, tool));
          }
        }
      } catch {
        /* 非 JSON 忽略 */
      }
    }

    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
