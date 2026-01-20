import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import * as readline from "node:readline/promises";

dotenv.config();

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "Please set OPENAI_API_KEY in your .env file or environment variables."
    );
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "./src/server.ts"],
  });

  const client = new Client(
    {
      name: "example-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  // List tools
  const { tools } = await client.listTools();
  console.log(
    "Connected to server. Available tools:",
    tools.map((t) => t.name).join(", ")
  );

  const openai = new OpenAI({ apiKey });
  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a helpful assistant. You can use tools to create users.",
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const userInput = await rl.question("\nYou: ");
    if (userInput.toLowerCase() === "exit") break;

    messages.push({ role: "user", content: userInput });

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: messages,
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      });

      const message = completion.choices[0].message;
      messages.push(message);

      if (message.tool_calls) {
        console.log("Tool calls requested:", message.tool_calls.length);

        for (const toolCall of message.tool_calls) {
          if (toolCall.type !== "function") continue;

          console.log(`Executing ${toolCall.function.name}...`);

          const args = JSON.parse(toolCall.function.arguments);
          const result = await client.callTool({
            name: toolCall.function.name,
            arguments: args,
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result.content),
          });
        }

        // Get final response after tool execution
        const finalResponse = await openai.chat.completions.create({
          model: "gpt-4",
          messages: messages,
        });

        const finalContent = finalResponse.choices[0].message.content;
        console.log(`Bot: ${finalContent}`);
        messages.push(finalResponse.choices[0].message);
      } else {
        console.log(`Bot: ${message.content}`);
      }
    } catch (error) {
      console.error("Error:", error);
    }
  }

  rl.close();
  await client.close();
}

main().catch(console.error);
