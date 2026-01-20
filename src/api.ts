import express from "express";
import cors from "cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { Groq } from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = 3000;

// Initialize clients
let client: Client | null = null;
let tools: any[] = [];
let openai: OpenAI | null = null;
let groq: Groq | null = null;

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
      "No LLM API keys found (OPENAI_API_KEY or GROQ_API_KEY). Chat will fail."
    );
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "./src/server.ts"],
  });

  client = new Client(
    { name: "api-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  const result = await client.listTools();
  tools = result.tools;

  console.log(
    "MCP Client connected. Tools:",
    tools.map((t) => t.name).join(", ")
  );
}

// Conversation history (simple in-memory for demo)
let messages: any[] = [
  {
    role: "system",
    content: "You are a helpful assistant. You can use tools to manage users.",
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

app.listen(port, () => {
  console.log(`API Server running at http://localhost:${port}`);
  initMcpClient().catch(console.error);
});
