import express from "express";
import cors from "cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { Groq } from "groq-sdk";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = 3000;

// ==================================================================================
// CONFIGURATION - HARDCODED TO FIX 401 & 404 ERRORS
// ==================================================================================
const DOMO_DEVELOPER_TOKEN = "DDCI76138cf6c0d4d712a99283d40a94e6d44a89ca1bdac63da4";
const DOMO_DOMAIN = "https://gwcteq-partner.domo.com";
const DOMO_PUBLIC_API = "https://api.domo.com"; // REQUIRED for Dataset SQL Queries
const CREDITS_DATASET_ID = "5847a9d2-cb5b-454b-8f25-5ecf367a1b82";

// Initialize clients
let client: Client | null = null;
let tools: any[] = [];
let openai: OpenAI | null = null;
let groq: Groq | null = null;

// Helper to convert Domo timestamp to ISO string
function convertDomoTimestamp(timestamp: string | number): string {
  try {
    if (typeof timestamp === 'string') {
      const num = parseInt(timestamp);
      if (!isNaN(num) && num > 1000000000000) {
        return new Date(num).toISOString();
      }
    } else if (typeof timestamp === 'number' && timestamp > 1000000000000) {
      return new Date(timestamp).toISOString();
    }
    return new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function initMcpClient() {
  // Initialize OpenAI if key is available
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // Initialize Groq if key is available
  if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  if (!openai && !groq) {
    console.warn(
      "No LLM API keys found (OPENAI_API_KEY or GROQ_API_KEY). Chat will fail.",
    );
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "./src/server.ts"],
  });

  client = new Client(
    { name: "api-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  const result = await client.listTools();
  tools = result.tools;

  console.log(
    "MCP Client connected. Tools:",
    tools.map((t) => t.name).join(", "),
  );
}

// Conversation history (simple in-memory for demo)
let messages: any[] = [
  {
    role: "system",
    content: `You are a helpful assistant for the Domo AI Agent Compass. 
You have access to tools for managing Domo users, searching and running Dataflows, querying collections, and managing Workflows.
CRITICAL: Always prefer using tools over providing code snippets. If a user asks to trigger a workflow, use the 'trigger-workflow-message' tool.
If required inputs for a tool are missing (like modelId or messageName for workflows), ask the user for them instead of giving code or making up values.`,
  },
];

app.post("/chat", async (req: any, res: any) => {
  const { prompt, provider = "groq", model } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    if (!client) await initMcpClient();

    const selectedProvider = provider.toLowerCase();
    let llmClient: any = null;
    let defaultModel = "";

    if (selectedProvider === "openai") {
      if (!openai)
        return res
          .status(400)
          .json({ error: "OpenAI not configured (missing API key)" });
      llmClient = openai;
      defaultModel = "gpt-4o-mini";
    } else if (selectedProvider === "groq") {
      if (!groq)
        return res
          .status(400)
          .json({ error: "Groq not configured (missing API key)" });
      llmClient = groq;
      defaultModel = "llama-3.1-8b-instant";
    } else {
      return res
        .status(400)
        .json({ error: `Unsupported provider: ${provider}` });
    }

    const selectedModel = model || defaultModel;
    console.log(`Using provider: ${selectedProvider}, model: ${selectedModel}`);

    messages.push({ role: "user", content: prompt });

    // Limit history
    if (messages.length > 10) {
      messages = [messages[0], ...messages.slice(-9)];
    }

    const completionBody: any = {
      model: selectedModel,
      messages: messages,
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    };

    const completion = await llmClient.chat.completions.create(completionBody);
    const message = completion.choices[0].message;
    messages.push(message);

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;

        console.log(`Executing tool: ${toolCall.function.name}`);
        const args = JSON.parse(toolCall.function.arguments);

        const result = await client!.callTool({
          name: toolCall.function.name,
          arguments: args,
        });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.content),
        });
      }

      // Get final response
      const finalCompletion = await llmClient.chat.completions.create({
        model: selectedModel,
        messages: messages,
      });

      const finalContent = finalCompletion.choices[0].message.content;
      messages.push(finalCompletion.choices[0].message);

      return res.json({
        response: finalContent,
        provider: selectedProvider,
        model: selectedModel,
      });
    }

    return res.json({
      response: message.content,
      provider: selectedProvider,
      model: selectedModel,
    });
  } catch (error: any) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: error.message });
  }
});

/* 
====================================================
DOMO WORKFLOW INTEGRATION WITH PROPER DATA MAPPING
====================================================
*/

async function fetchUsers(token: string) {
  try {
    const res = await axios.get(
      `${DOMO_DOMAIN}/api/content/v3/users?limit=500&offset=0&active=true`,
      {
        headers: {
          "X-DOMO-Developer-Token": token,
          "Accept": "application/json"
        }
      }
    );

    const map = new Map<string, string>();
    if (res.data && Array.isArray(res.data)) {
      res.data.forEach((u: any) => {
        // Get proper user name from Domo
        const name = u.displayName || u.name || u.userName || `User ${u.id}`;
        map.set(String(u.id), name);
      });
    }
    return map;
  } catch (e: any) {
    console.error("Error fetching users:", e.message);
    return new Map();
  }
}

// ============================================================
// FIXED: Fetch Real Credits from Domo Dataset
// ============================================================
// This function fetches REAL credit usage from your Domo dataset
// and maps it to workflow instanceIds
// ============================================================

// ============================================================
// FETCH REAL CREDITS (LAST 7 DAYS) USING DOMO SQL QUERY
// ============================================================
async function fetchRealCreditsMap(token: string): Promise<Map<string, number>> {
  try {
    const endpoint = `${DOMO_DOMAIN}/api/query/v1/execute/${CREDITS_DATASET_ID}`;

    const sql = `
      SELECT entityId, SUM(creditsUsed)
      FROM credit_usage
      WHERE entityType = 'Workflow'
        AND skuId IN ('workflows-task-completed')
        AND date >= CURRENT_DATE - INTERVAL '30' DAY
      GROUP BY entityId
    `;

    const res = await axios.post(endpoint, { sql }, {
      headers: {
        "Content-Type": "application/json",
        "X-DOMO-Developer-Token": token
      }
    });

    const map = new Map<string, number>();
    const rows = res.data?.rows || [];

    rows.forEach((row: any) => {
      const workflowId = String(row[0]);
      const credits = parseFloat(row[1]);
      if (workflowId && !isNaN(credits)) {
        map.set(workflowId, credits);
      }
    });

    console.log(`Credits map loaded: ${map.size} workflows`);
    return map;
  } catch (error) {
    console.error("Credits fetch error:", error);
    return new Map();
  }
}


async function fetchExecutionCreditsMap(token: string, workflowId: string) {
  try {
    const endpoint = `${DOMO_DOMAIN}/api/query/v1/execute/${CREDITS_DATASET_ID}`;

    const sql = `
  SELECT
    instanceId,
    SUM(creditsUsed) AS total_credits
  FROM credit_usage
  WHERE entityType = 'Workflow'
    AND entityId = '${workflowId}'
    AND skuId IN ('workflows-task-completed')
    
  GROUP BY instanceId
`;

    const res = await axios.post(
      endpoint,
      { sql },
      {
        headers: {
          "Content-Type": "application/json",
          "X-DOMO-Developer-Token": token
        }
      }
    );

    const rows = res.data?.rows || [];
    const map = new Map<string, number>();

    console.log(`=== Credits dataset rows for workflow ${workflowId} ===`);
    console.log(`Total credit rows: ${rows.length}`);
    rows.forEach((row: any) => {
      const instanceId = String(row[0]);
      const credits = parseFloat(row[1]);
      console.log(`  DATASET instanceId="${instanceId}" credits=${credits}`);
      map.set(instanceId, credits);
    });

    return map;
  } catch (e: any) {
    console.error("Execution credit fetch failed:", e.message);
    return new Map();
  }
}

// Get workflow trigger type from executions
async function getWorkflowTriggerType(token: string, workflowId: string): Promise<string> {
  try {
    const exeRes = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=1&sort=createdOn:desc`,
      {
        headers: {
          "X-DOMO-Developer-Token": token
        }
      }
    );

    const executions = exeRes.data || [];
    if (executions.length > 0) {
      const trigger = executions[0].triggerType || "manual";
      // Map Domo trigger types to your UI types
      if (trigger.toLowerCase().includes('manual')) return 'manual';
      if (trigger.toLowerCase().includes('schedule')) return 'schedule';
      if (trigger.toLowerCase().includes('webhook')) return 'webhook';
      if (trigger.toLowerCase().includes('shell')) return 'manual'; // Shell is manual trigger
      return trigger.toLowerCase();
    }
  } catch (error) {
    // console.log(`Could not get trigger type for ${workflowId}`);
  }
  return "manual"; // Default
}

// Get total usage (execution count) for workflow
async function getWorkflowUsage(token: string, workflowId: string): Promise<number> {
  try {
    // Get total execution count
    const exeRes = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=1000`,
      {
        headers: {
          "X-DOMO-Developer-Token": token
        }
      }
    );

    return exeRes.data?.length || 0;
  } catch (error) {
    // console.log(`Could not get usage for ${workflowId}`);
    return 0;
  }
}

// Get last 7 days execution count
async function getLast30DaysExecutions(token: string, workflowId: string): Promise<number> {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const exeRes = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=100&sort=createdOn:desc`,
      {
        headers: {
          "X-DOMO-Developer-Token": token
        }
      }
    );

    const executions = exeRes.data || [];
    const recentExecutions = executions.filter((exe: any) => {
      const execDate = new Date(exe.createdOn).getTime();
      return execDate >= thirtyDaysAgo.getTime();

    });

    return recentExecutions.length;
  } catch (error) {
    // console.log(`Could not get 7-day executions for ${workflowId}`);
    return 0;
  }
}

// ================= PAGINATED EXECUTION FETCH (LAST 7 DAYS) =================
async function fetchExecutionsLast30Days(token: string, workflowId: string) {
  const limit = 100;
  let offset = 0;
  let allExecutions: any[] = [];

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  console.log(`Fetching executions after: ${thirtyDaysAgo.toISOString()}`);

  while (true) {
    const res = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=${limit}&offset=${offset}&sort=createdOn:desc`,
      {
        headers: { "X-DOMO-Developer-Token": token }
      }
    );

    const executions = res.data || [];
    console.log(`Fetched ${executions.length} executions at offset ${offset}`);

    if (executions.length === 0) break;

    let hitOldData = false;
    for (const exe of executions) {
      const execDate = new Date(exe.createdOn);
      console.log(`  exe.id=${exe.id} createdOn=${exe.createdOn} passes30d=${execDate >= thirtyDaysAgo}`);

      if (execDate >= thirtyDaysAgo) {
        allExecutions.push(exe);
      } else {
        // Older than 30 days - stop fetching
        hitOldData = true;
        break;
      }
    }

    if (hitOldData || executions.length < limit) break;
    offset += limit;
  }

  console.log(`Total executions within 30 days: ${allExecutions.length}`);
  return allExecutions;
}
// ===================== (DEPRECATED: Old Credits Fetcher) =====================
// Kept for reference but replaced by fetchRealCreditsMap
async function fetchCreditsFromDataset(token: string) {
  // Logic replaced by fetchRealCreditsMap
  return [];
}

app.get("/api/workflows", async (req, res) => {
  try {
    console.log("=== Fetching Domo workflows with proper data mapping ===");

    // Use Hardcoded Token
    const TOKEN = DOMO_DEVELOPER_TOKEN;

    // 1. Fetch Real Credits Map First
    const creditsMapPromise = fetchRealCreditsMap(TOKEN);
    const userMapPromise = fetchUsers(TOKEN);

    // Get query parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string) || "";
    const offset = (page - 1) * limit;

    console.log(`Page: ${page}, Limit: ${limit}, Offset: ${offset}, Search: "${search}"`);

    // Build search query
    const query = search ? `*${search}*` : "*";

    // Fetch workflows from Domo Search API
    const searchPayload = {
      query: query,
      entityList: [["workflow_model"]],
      count: search ? 1000 : limit,
      offset: search ? 0 : offset,
      sort: {
        fieldSorts: [
          {
            field: "last_modified",
            sortOrder: "DESC"
          }
        ],
        isRelevance: search ? true : false
      },
      filters: [],
      useEntities: true,
      combineResults: true,
      facetValueLimit: 1000,
      hideSearchObjects: false
    };

    const searchRes = await axios.post(
      `${DOMO_DOMAIN}/api/search/v1/query`,
      searchPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-DOMO-Developer-Token": TOKEN
        }
      }
    );

    const searchData = searchRes.data;
    const totalWorkflows = searchData.totalResultCount || 0;
    let searchObjects = searchData.searchObjects || [];

    console.log(`✓ Found ${totalWorkflows} total workflows, showing ${searchObjects.length}`);

    // Filter search results if search term provided
    if (search) {
      searchObjects = searchObjects.filter((obj: any) => {
        const workflowName = obj.name || "";
        const ownerName = obj.ownedByName || "";
        return workflowName.toLowerCase().includes(search.toLowerCase()) ||
          ownerName.toLowerCase().includes(search.toLowerCase());
      });

      // Apply pagination after filtering
      searchObjects = searchObjects.slice(offset, offset + limit);
    }

    // Await maps
    const creditsMap = await creditsMapPromise;
    const userMap = await userMapPromise;

    // Process workflows with proper data mapping
    const workflows = await Promise.all(
      searchObjects.map(async (obj: any) => {
        const workflowId = obj.uuid;

        // Get Real Credits (Fixes "1 1 1")
        const realCredits = creditsMap.get(workflowId) || 0;

        // Get execution data
        let executions = [];
        let lastRunTime = "";
        let lastRunStatus = "success";
        let totalDuration = 0;
        let failedRuns = 0;

        try {
          const exeRes = await axios.get(
            `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=10&sort=createdOn:desc`,
            {
              headers: {
                "X-DOMO-Developer-Token": TOKEN
              }
            }
          );

          executions = exeRes.data || [];

          if (executions.length > 0) {
            const latestExecution = executions[0];
            lastRunTime = latestExecution.createdOn;
            lastRunStatus = latestExecution.status === "FAILED" ? "fail" :
              latestExecution.status === "ABORTED" ? "cancel" : "success";

            // Calculate metrics
            executions.forEach((exe: any) => {
              if (exe.status === "FAILED") failedRuns++;
              if (exe.createdOn && exe.completedOn) {
                totalDuration += Math.round(
                  (new Date(exe.completedOn).getTime() - new Date(exe.createdOn).getTime()) / 1000
                );
              }
            });
          }
        } catch (exeError: any) {
          // console.log(`No execution data for ${obj.name || 'Unknown Workflow'}`);
        }

        const executions30d = await fetchExecutionsLast30Days(TOKEN, workflowId);
        const runs30d = executions30d.length;
        const failedRuns30d = executions30d.filter((e: any) => e.status === "FAILED").length;
        const failureRate30d = runs30d > 0 ? failedRuns30d / runs30d : 0;


        let totalDuration30d = 0;
        executions30d.forEach((exe: any) => {
          if (exe.createdOn && exe.completedOn) {
            totalDuration30d += Math.round(
              (new Date(exe.completedOn).getTime() - new Date(exe.createdOn).getTime()) / 1000
            );
          }
        });

        const avgDuration30d = runs30d > 0 ? Math.round(totalDuration30d / runs30d) : 0;

        const usage = runs30d;
        const triggerType = await getWorkflowTriggerType(TOKEN, workflowId);


        // Get proper owner name (from your Domo screenshots, ownedByName seems to work)
        const owner = obj.ownedByName || "Unknown";

        // Determine folder from metadata
        let folder = "General";
        if (obj.metadata && obj.metadata.folder) {
          folder = obj.metadata.folder;
        } else if (obj.tags && obj.tags.length > 0) {
          folder = obj.tags[0];
        }

        // Get status from Domo data
        const status = obj.active ? "enabled" : "disabled";

        return {
          workflow_id: workflowId,
          name: obj.name || "Unnamed Workflow",
          folder: folder,
          workspace: "Default",
          owner: owner,
          trigger_type: triggerType, // ACTUAL trigger type from executions
          status: status,
          last_run_time: lastRunTime || convertDomoTimestamp(obj.lastModified || obj.createDate),
          last_run_status: lastRunStatus,
          failure_rate_30d: failureRate30d,
          run_count_30d: runs30d,
          usage: usage, // Total executions (like Domo shows in Usage column)
          credits_estimate_30d: parseFloat(realCredits.toFixed(2)), // USING REAL DATASET DATA
          downstream_impacts: {
            datasets: obj.inputDatasets?.length || 0,
            cards: obj.outputCards?.length || 0,
            apps: obj.connectedApps?.length || 0
          }
        };
      })
    );

    // Calculate pagination
    const actualTotal = search ? searchObjects.length : totalWorkflows;
    const totalPages = Math.ceil(actualTotal / limit);

    const rawDatasetCount = creditsMap.size;

    // Return response
    const response = {
      data: workflows,
      pagination: {
        page: page,
        limit: limit,
        total: actualTotal,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        rawDatasetCount: rawDatasetCount,
        searchTerm: search || null
      }
    };

    console.log(`✓ Returning ${workflows.length} workflows with proper Domo data mapping`);
    return res.json(response);

  } catch (error: any) {
    console.error("✗ ERROR fetching workflows:", error.message);
    return res.status(500).json({
      error: "Failed to fetch workflows",
      message: error.message
    });
  }
});

// ============================================================
// WORKFLOW DETAILS — FULL REAL DATA (7 DAY WINDOW, PAGINATED)
// ============================================================
// ============================================================
// WORKFLOW DETAILS — FULL REAL DATA (30 DAY WINDOW)
// ============================================================
app.get("/api/workflows/:id", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    const modelId = req.params.id;

    // ---------------- FETCH REAL TOTAL CREDITS ----------------
    const creditsMap = await fetchRealCreditsMap(TOKEN);
    const totalRealCredits = creditsMap.get(modelId) || 0;

    // ---------------- FETCH WORKFLOW MODEL ----------------
    let workflowName = "Unknown Workflow";
    let downstreamDatasets = 0;
    let downstreamCards = 0;
    let downstreamApps = 0;
    let workflowOwnerName = "Unknown";

    try {
      const modelRes = await axios.get(
        `${DOMO_DOMAIN}/api/workflow/v1/models/${modelId}?parts=users`,
        { headers: { "X-DOMO-Developer-Token": TOKEN } }
      );
      const model = modelRes.data || {};
      workflowName = model.name || "Unknown Workflow";
      downstreamDatasets = model.inputDatasets?.length || 0;
      downstreamCards = model.outputCards?.length || 0;
      downstreamApps = model.connectedApps?.length || 0;
    } catch (e) {
      console.log("Model fetch failed, continuing...");
    }

    // ---------------- FETCH EXECUTIONS (30 DAYS) ----------------
    const executions = await fetchExecutionsLast30Days(TOKEN, modelId);

    console.log(`=== Workflow ${modelId}: found ${executions.length} executions in last 30 days ===`);
    executions.forEach((e: any) => {
      console.log(`  exe.id=${e.id} status=${e.status} createdOn=${e.createdOn}`);
    });

    // ---------------- FETCH CREDITS PER INSTANCE ----------------
    const executionCreditsMap = await fetchExecutionCreditsMap(TOKEN, modelId);

    // If no executions, return empty with credits still shown
    if (executions.length === 0) {
      return res.json({
        workflow: {
          workflow_id: modelId,
          name: workflowName,
          owner: workflowOwnerName,
          trigger_type: "manual",
          status: "enabled",
          avg_duration: 0,
          failure_rate_30d: 0,
          run_count_30d: 0,
          usage: 0,
          credits_estimate_30d: parseFloat(totalRealCredits.toFixed(2)),
          downstream_impacts: {
            datasets: downstreamDatasets,
            cards: downstreamCards,
            apps: downstreamApps
          }
        },
        runs: []
      });
    }

    // ---------------- MAP USERS ----------------
    const userMap = await fetchUsers(TOKEN);

    // ---------------- CALCULATE METRICS ----------------
    const totalRuns = executions.length;
    const failedRuns = executions.filter((e: any) => e.status === "FAILED").length;

    let totalDuration = 0;
    executions.forEach((exe: any) => {
      if (exe.createdOn && exe.completedOn) {
        totalDuration += Math.round(
          (new Date(exe.completedOn).getTime() - new Date(exe.createdOn).getTime()) / 1000
        );
      }
    });

    const avgDuration = totalRuns > 0 ? Math.round(totalDuration / totalRuns) : 0;
    const failureRate = totalRuns > 0 ? failedRuns / totalRuns : 0;

    // ---------------- LATEST EXECUTION FOR METADATA ----------------
    const latest = executions[0];
    const owner = userMap.get(String(latest.createdBy)) || "Unknown";

    let triggerType = "manual";
    if (latest.triggerType) {
      const t = latest.triggerType.toLowerCase();
      if (t.includes("schedule")) triggerType = "schedule";
      else if (t.includes("webhook")) triggerType = "webhook";
    }

    // ---------------- CREDITS PER RUN ----------------
    // The dataset instanceId does NOT match exe.id directly.
    // Strategy: distribute total credits evenly across all runs.
    // If dataset has per-instance rows, use those; otherwise distribute evenly.
    const creditsPerRun = totalRuns > 0
      ? parseFloat((totalRealCredits / totalRuns).toFixed(4))
      : 0;

    console.log(`Total credits: ${totalRealCredits}, runs: ${totalRuns}, per run: ${creditsPerRun}`);
    console.log(`Dataset instanceId entries: ${executionCreditsMap.size}`);

    // ---------------- BUILD TIMELINE ----------------
    const runs = executions.map((exe: any) => {
      let status = "success";
      if (exe.status === "FAILED") status = "fail";
      else if (exe.status === "RUNNING") status = "running";
      else if (exe.status === "ABORTED") status = "cancel";
      else if (exe.status === "COMPLETED") status = "success";

      let duration = 0;
      if (exe.createdOn && exe.completedOn) {
        duration = Math.round(
          (new Date(exe.completedOn).getTime() - new Date(exe.createdOn).getTime()) / 1000
        );
      }

      // Try to get credits: first by exe.id, then by deploymentId, then use per-run average
      const creditByExeId = executionCreditsMap.get(exe.id) || 0;
      const creditByDeployment = executionCreditsMap.get(exe.deploymentId) || 0;
      const runCredits = creditByExeId || creditByDeployment || creditsPerRun;

      return {
        run_id: exe.id,
        workflow_id: exe.modelId,
        start_time: exe.createdOn,
        end_time: exe.completedOn || null,
        duration: duration,
        status: status,
        credits_estimate: parseFloat(runCredits.toFixed(4)),
        error_summary: exe.errorMessage || "-"
      };
    });

    // ---------------- FINAL RESPONSE ----------------
    const workflow = {
      workflow_id: modelId,
      name: workflowName,
      owner: owner,
      trigger_type: triggerType,
      status: "enabled",
      avg_duration: avgDuration,
      failure_rate_30d: parseFloat(failureRate.toFixed(4)),
      run_count_30d: totalRuns,
      usage: totalRuns,
      credits_estimate_30d: parseFloat(totalRealCredits.toFixed(2)),
      downstream_impacts: {
        datasets: downstreamDatasets,
        cards: downstreamCards,
        apps: downstreamApps
      }
    };

    console.log(`✓ Returning workflow detail: ${workflowName}, runs: ${runs.length}`);
    res.json({ workflow, runs });

  } catch (error: any) {
    console.error("Workflow detail error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow detail" });
  }
});
// ========== ADD MISSING ENDPOINTS FOR FRONTEND ==========

// Endpoint for /api/domo/workflows (to fix frontend errors)
app.get("/api/domo/workflows", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string) || "";
    const offset = (page - 1) * limit;

    const query = search ? `*${search}*` : "*";

    const searchPayload = {
      query: query,
      entityList: [["workflow_model"]],
      count: search ? 1000 : limit,
      offset: search ? 0 : offset,
      sort: {
        fieldSorts: [
          {
            field: "last_modified",
            sortOrder: "DESC"
          }
        ],
        isRelevance: search ? true : false
      },
      filters: [],
      useEntities: true,
      combineResults: true,
      facetValueLimit: 1000,
      hideSearchObjects: false
    };

    const searchRes = await axios.post(
      `${DOMO_DOMAIN}/api/search/v1/query`,
      searchPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-DOMO-Developer-Token": TOKEN
        }
      }
    );

    const searchData = searchRes.data;
    const totalWorkflows = searchData.totalResultCount || 0;
    let searchObjects = searchData.searchObjects || [];

    if (search) {
      searchObjects = searchObjects.filter((obj: any) => {
        const workflowName = obj.name || "";
        const ownerName = obj.ownedByName || "";
        return workflowName.toLowerCase().includes(search.toLowerCase()) ||
          ownerName.toLowerCase().includes(search.toLowerCase());
      });

      searchObjects = searchObjects.slice(offset, offset + limit);
    }

    const userMap = await fetchUsers(TOKEN);

    const workflows = await Promise.all(
      searchObjects.map(async (obj: any) => {
        const workflowId = obj.uuid;

        // Get execution data
        let executions = [];
        let lastRunTime = "";
        let lastRunStatus = "success";
        let totalDuration = 0;
        let failedRuns = 0;

        try {
          const exeRes = await axios.get(
            `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=10&sort=createdOn:desc`,
            {
              headers: {
                "X-DOMO-Developer-Token": TOKEN
              }
            }
          );

          executions = exeRes.data || [];

          if (executions.length > 0) {
            const latestExecution = executions[0];
            lastRunTime = latestExecution.createdOn;
            lastRunStatus = latestExecution.status === "FAILED" ? "fail" :
              latestExecution.status === "ABORTED" ? "cancel" : "success";

            executions.forEach((exe: any) => {
              if (exe.status === "FAILED") failedRuns++;
              if (exe.createdOn && exe.completedOn) {
                totalDuration += Math.round(
                  (new Date(exe.completedOn).getTime() - new Date(exe.createdOn).getTime()) / 1000
                );
              }
            });
          }
        } catch (exeError: any) {
          console.log(`No execution data for ${obj.name || 'Unknown Workflow'}`);
        }

        const usage = await getWorkflowUsage(TOKEN, workflowId);
        const runs30d = await getLast30DaysExecutions(TOKEN, workflowId);
        const triggerType = await getWorkflowTriggerType(TOKEN, workflowId);

        const runCount = executions.length;
        const avgDuration = runCount > 0 ? Math.round(totalDuration / runCount) : 0;
        const failureRate = runCount > 0 ? failedRuns / runCount : 0;

        const owner = obj.ownedByName || "Unknown";

        let folder = "General";
        if (obj.metadata && obj.metadata.folder) {
          folder = obj.metadata.folder;
        } else if (obj.tags && obj.tags.length > 0) {
          folder = obj.tags[0];
        }

        const status = obj.active ? "enabled" : "disabled";

        return {
          id: workflowId,
          name: obj.name || "Unnamed Workflow",
          folder: folder,
          workspace: "Default",
          owner: owner,
          triggerType: triggerType,
          active: obj.active,
          lastRunTime: lastRunTime,
          lastRunStatus: lastRunStatus,
          avgDuration: avgDuration,
          usage: usage,
          runCount: runCount
        };
      })
    );

    res.json(workflows);

  } catch (error: any) {
    console.error("Error fetching Domo workflows:", error.message);
    res.status(500).json({ error: "Failed to fetch workflows" });
  }
});

// Endpoint for /api/domo/workflows/:id
app.get("/api/domo/workflows/:id/credits", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    const workflowId = req.params.id;

    // 🔥 Get REAL credits from dataset
    const creditsMap = await fetchRealCreditsMap(TOKEN);
    const totalCredits = creditsMap.get(workflowId) || 0;

    // Get executions (for avg)
    const executions = await fetchExecutionsLast30Days(TOKEN, workflowId);
    const runs = executions.length;
    const avg = runs > 0 ? totalCredits / runs : 0;

    res.json({
      total: parseFloat(totalCredits.toFixed(4)),
      last30Days: parseFloat(totalCredits.toFixed(4)),
      averagePerRun: parseFloat(avg.toFixed(4))
    });

  } catch (error: any) {
    console.error("Error fetching credits:", error.message);
    res.status(500).json({ total: 0, last30Days: 0 });
  }
});

// Simple endpoint for /api/domo/workflows/:id/runs
app.get("/api/domo/workflows/:id/runs", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    const workflowId = req.params.id;

    const response = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=50&sort=createdOn:desc`,
      {
        headers: {
          "X-DOMO-Developer-Token": TOKEN,
          "Accept": "application/json"
        }
      }
    );

    const runs = response.data || [];
    const executionCreditsMap = await fetchExecutionCreditsMap(TOKEN, workflowId);

    const transformedRuns = runs.map((run: any) => ({
      id: run.id,
      startTime: run.createdOn,
      endTime: run.completedOn || null,
      duration: run.duration || 0,
      status: run.status || 'UNKNOWN',
      creditsUsed: parseFloat(
        (executionCreditsMap.get(run.id) || 0).toFixed(4)
      ),

      errorMessage: run.errorMessage || null
    }));

    res.json(transformedRuns);
  } catch (error: any) {
    console.error("Error fetching runs:", error.message);
    res.status(500).json({ error: "Failed to fetch runs" });
  }
});

// Simple endpoint for /api/domo/workflows/:id/dependencies
app.get("/api/domo/workflows/:id/dependencies", async (req, res) => {
  try {
    // Return default values
    res.json({
      datasets: 0,
      cards: 0,
      apps: 0
    });
  } catch (error: any) {
    console.error("Error fetching dependencies:", error.message);
    res.status(500).json({ datasets: 0, cards: 0, apps: 0 });
  }
});

// ============================================================
// CREDITS SUMMARY — REAL DATA (LAST 7 DAYS)
// ============================================================
app.get("/api/credits-summary", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    console.log("=== Fetching Credits Summary (30d) ===");

    // 1. Get real credits per workflow from dataset
    const creditsMap = await fetchRealCreditsMap(TOKEN);

    // 2. Get workflow names from search API in ONE call
    const searchPayload = {
      query: "*",
      entityList: [["workflow_model"]],
      count: 1000,
      offset: 0,
      sort: {
        fieldSorts: [{ field: "last_modified", sortOrder: "DESC" }],
        isRelevance: false
      },
      filters: [],
      useEntities: true,
      combineResults: true,
      facetValueLimit: 1000,
      hideSearchObjects: false
    };

    const searchRes = await axios.post(
      `${DOMO_DOMAIN}/api/search/v1/query`,
      searchPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-DOMO-Developer-Token": TOKEN
        }
      }
    );

    // Build workflowId → name map from search results
    const nameMap = new Map<string, string>();
    const searchObjects = searchRes.data?.searchObjects || [];
    searchObjects.forEach((obj: any) => {
      if (obj.uuid && obj.name) {
        nameMap.set(obj.uuid, obj.name);
      }
    });

    console.log(`Name map loaded: ${nameMap.size} workflow names`);

    // 3. Build top workflows list — NO per-workflow API calls
    let totalCredits = 0;
    const topWorkflows: any[] = [];

    for (const [workflowId, credits] of creditsMap.entries()) {
      totalCredits += credits;
      topWorkflows.push({
        workflow_id: workflowId,
        name: nameMap.get(workflowId) || workflowId, // Show name, fallback to ID
        credits: parseFloat(credits.toFixed(2)),
        run_count_30d: 0 // We skip per-workflow run fetch for speed
      });
    }

    // 4. Sort by credits descending
    topWorkflows.sort((a, b) => b.credits - a.credits);
    const top20 = topWorkflows.slice(0, 20);

    console.log(`✓ Credits summary ready: ${totalCredits.toFixed(2)} total credits`);

    res.json({
      totalCredits: parseFloat(totalCredits.toFixed(2)),
      totalCost: parseFloat((totalCredits * 0.002).toFixed(4)),
      totalRuns: 0,
      creditsWasted: 0,
      topWorkflows: top20,
      topAgentsByCost: []
    });

  } catch (err: any) {
    console.error("Credits summary error:", err.message);
    res.status(500).json({
      error: "Failed to fetch credits",
      details: err.message
    });
  }
});
// TEMP DEBUG ROUTE - remove after fixing
app.get("/api/debug/workflow/:id", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    const modelId = req.params.id;

    console.log("=== DEBUG: Fetching executions for", modelId);

    // Raw fetch - no date filter
    const exeRes = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${modelId}&limit=20&sort=createdOn:desc`,
      {
        headers: { "X-DOMO-Developer-Token": TOKEN }
      }
    );

    const executions = exeRes.data || [];
    console.log("Total executions returned:", executions.length);

    if (executions.length > 0) {
      console.log("Sample execution keys:", Object.keys(executions[0]));
      console.log("Sample execution[0]:", JSON.stringify(executions[0], null, 2));
    }

    res.json({
      total: executions.length,
      sample: executions.slice(0, 3)
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Debug workflow model structure
app.get("/api/debug/model/:id", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    const modelId = req.params.id;

    const modelRes = await axios.get(
      `${DOMO_DOMAIN}/api/workflow/v1/models/${modelId}?parts=users`,
      { headers: { "X-DOMO-Developer-Token": TOKEN } }
    );

    console.log("Model API response:", JSON.stringify(modelRes.data, null, 2));
    res.json(modelRes.data);

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RUNS & INCIDENTS — REAL DATA FROM DOMO
// ============================================================
app.get("/api/runs-incidents", async (req, res) => {
  try {
    const TOKEN = DOMO_DEVELOPER_TOKEN;
    console.log("=== Fetching Runs & Incidents ===");

    // 1. Get all workflows from search API
    const searchPayload = {
      query: "*",
      entityList: [["workflow_model"]],
      count: 1000,
      offset: 0,
      sort: { fieldSorts: [{ field: "last_modified", sortOrder: "DESC" }], isRelevance: false },
      filters: [],
      useEntities: true,
      combineResults: true,
      facetValueLimit: 1000,
      hideSearchObjects: false
    };

    const searchRes = await axios.post(
      `${DOMO_DOMAIN}/api/search/v1/query`,
      searchPayload,
      { headers: { "Content-Type": "application/json", "X-DOMO-Developer-Token": TOKEN } }
    );

    const searchObjects = searchRes.data?.searchObjects || [];
    const userMap = await fetchUsers(TOKEN);

    // 2. For each workflow fetch recent executions to find failures
    const incidents: any[] = [];
    const failedRuns: any[] = [];

    // Process top 20 workflows only for speed
    const workflowsToCheck = searchObjects.slice(0, 20);

    await Promise.all(workflowsToCheck.map(async (obj: any) => {
      const workflowId = obj.uuid;
      const workflowName = obj.name || "Unknown";
      const owner = obj.ownedByName || "Unassigned";

      try {
        const exeRes = await axios.get(
          `${DOMO_DOMAIN}/api/workflow/v1/instances?modelId=${workflowId}&limit=20&sort=createdOn:desc`,
          { headers: { "X-DOMO-Developer-Token": TOKEN } }
        );

        const executions = exeRes.data || [];
        if (executions.length === 0) return;

        const failed = executions.filter((e: any) => e.status === "FAILED");
        const failRate = executions.length > 0 ? failed.length / executions.length : 0;

        // Generate incident if failure rate > 10%
        if (failRate > 0.1) {
          const severity =
            failRate >= 0.5 ? "critical" :
            failRate >= 0.3 ? "high" :
            failRate >= 0.2 ? "medium" : "low";

          incidents.push({
            incident_id: `inc_${workflowId}`,
            entity_type: "workflow",
            entity_id: workflowId,
            entity_name: workflowName,
            owner: owner,
            issue: `High failure rate: ${Math.round(failRate * 100)}% over last ${executions.length} runs`,
            severity: severity,
            last_activity: executions[0].createdOn,
            recommended_action: "Review recent error logs and check workflow configuration",
            status: "active"
          });
        }

        // Also flag orphaned workflows (no owner)
        if (!obj.ownedByName || obj.ownedByName === "") {
          incidents.push({
            incident_id: `inc_orphan_${workflowId}`,
            entity_type: "workflow",
            entity_id: workflowId,
            entity_name: workflowName,
            owner: "Unassigned",
            issue: "Orphaned workflow: no owner assigned",
            severity: "medium",
            last_activity: executions[0]?.createdOn || new Date().toISOString(),
            recommended_action: "Assign owner for governance compliance",
            status: "active"
          });
        }

        // Collect failed runs
        // Get credits map for this workflow
        const creditsMap = await fetchExecutionCreditsMap(TOKEN, workflowId);
        const totalCredits = creditsMap.values().next().value || 0;
        const creditsPerRun = executions.length > 0
          ? parseFloat((totalCredits / executions.length).toFixed(4))
          : 0;

        failed.slice(0, 3).forEach((exe: any) => {
          // Duration: use updatedOn as fallback if completedOn is null
          let duration = 0;
          const endTime = exe.completedOn || exe.updatedOn;
          if (exe.createdOn && endTime) {
            const diff = Math.round(
              (new Date(endTime).getTime() - new Date(exe.createdOn).getTime()) / 1000
            );
            duration = diff > 0 ? diff : 0;
          }

          // Credits: try exact match first, fallback to per-run average
          const runCredits = creditsMap.get(exe.id) || creditsPerRun;

          failedRuns.push({
            run_id: exe.id,
            workflow_id: workflowId,
            workflow_name: workflowName,
            owner: owner,
            start_time: exe.createdOn,
            end_time: endTime || null,
            duration: duration,
            status: "fail",
            error_summary: exe.errorMessage || "Execution failed",
            credits_estimate: parseFloat(runCredits.toFixed(4))
          });
        });

      } catch (e: any) {
        // Skip workflows with no execution data
      }
    }));

    // Sort incidents by severity
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    incidents.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

    // Sort failed runs by start_time desc
    failedRuns.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

    console.log(`✓ Incidents: ${incidents.length}, Failed runs: ${failedRuns.length}`);

    res.json({
      incidents,
      failedRuns,
      summary: {
        totalIncidents: incidents.length,
        criticalCount: incidents.filter(i => i.severity === "critical").length,
        highCount: incidents.filter(i => i.severity === "high").length,
        totalFailedRuns: failedRuns.length
      }
    });

  } catch (err: any) {
    console.error("Runs & Incidents error:", err.message);
    res.status(500).json({ error: "Failed to fetch runs and incidents" });
  }
});
// ========== SERVER START ==========
app.listen(port, () => {
  console.log(`API Server running at http://localhost:${port}`);
  initMcpClient().catch(console.error);
});