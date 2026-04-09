import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const AUTH_TOKEN = "2222222222";

const MODELS = [
  {
    id: "claude-opus-4-6",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
  {
    id: "claude-haiku-4-5",
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
  },
];

function authenticate(req: Request, res: Response): boolean {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({
      error: { message: "Unauthorized", type: "auth_error", code: 401 },
    });
    return false;
  }
  const token = auth.slice(7).trim();
  if (token !== AUTH_TOKEN) {
    res.status(401).json({
      error: { message: "Invalid API key", type: "auth_error", code: 401 },
    });
    return false;
  }
  return true;
}

function mapModelToAnthropic(model: string): string {
  const map: Record<string, string> = {
    "gpt-4": "claude-opus-4-6",
    "gpt-4o": "claude-opus-4-6",
    "gpt-4-turbo": "claude-opus-4-6",
    "gpt-3.5-turbo": "claude-haiku-4-5",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5": "claude-haiku-4-5",
    "claude-opus-4-5": "claude-opus-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-6",
  };
  return map[model] ?? "claude-sonnet-4-6";
}

function parseMessages(messages: { role: string; content: string | { type: string; text: string }[] }[]): {
  system?: string;
  chatMessages: { role: "user" | "assistant"; content: string }[];
} {
  let system: string | undefined;
  const chatMessages: { role: "user" | "assistant"; content: string }[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((b) => ("text" in b ? b.text : "")).join("");

    if (msg.role === "system") {
      system = content;
    } else if (msg.role === "user" || msg.role === "assistant") {
      chatMessages.push({ role: msg.role as "user" | "assistant", content });
    }
  }

  if (chatMessages.length === 0) {
    chatMessages.push({ role: "user", content: "Hello" });
  }

  return { system, chatMessages };
}

router.get("/models", (req, res) => {
  if (!authenticate(req, res)) return;
  res.json({ object: "list", data: MODELS });
});

router.post("/chat/completions", async (req, res) => {
  if (!authenticate(req, res)) return;

  const baseUrl = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];

  if (!baseUrl || !apiKey) {
    res.status(500).json({
      error: { message: "Anthropic integration not configured", type: "server_error" },
    });
    return;
  }

  const body = req.body as {
    model?: string;
    messages?: { role: string; content: string | { type: string; text: string }[] }[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
  };

  const anthropicModel = mapModelToAnthropic(body.model ?? "claude-sonnet-4-6");
  const wantStream = body.stream === true;
  const { system, chatMessages } = parseMessages(body.messages ?? []);

  const anthropicBody: Record<string, unknown> = {
    model: anthropicModel,
    max_tokens: body.max_tokens ?? 8192,
    messages: chatMessages,
    stream: wantStream,
  };
  if (system) anthropicBody["system"] = system;
  if (body.temperature !== undefined) anthropicBody["temperature"] = body.temperature;
  if (body.top_p !== undefined) anthropicBody["top_p"] = body.top_p;

  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    const anthropicRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });

    // ── STREAMING ──────────────────────────────────────────────────────────
    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      // Flush headers immediately so clients don't wait
      res.flushHeaders();

      const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, number>) => {
        const chunk: Record<string, unknown> = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: anthropicModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        if (usage) chunk["usage"] = usage;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      if (!anthropicRes.ok || !anthropicRes.body) {
        const errText = await anthropicRes.text();
        logger.error({ status: anthropicRes.status, body: errText }, "Anthropic streaming error");
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      const reader = anthropicRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let firstContentSent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // Anthropic SSE format: lines starting with "data: "
          // (event: lines are event type hints we handle via data type field)
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = event["type"] as string | undefined;

          // First real content: send role chunk first (OpenAI spec)
          if (type === "content_block_start" && !firstContentSent) {
            sendChunk({ role: "assistant", content: "" });
            firstContentSent = true;
          }

          // Real-time text delta
          if (type === "content_block_delta") {
            const delta = event["delta"] as { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              if (!firstContentSent) {
                sendChunk({ role: "assistant", content: "" });
                firstContentSent = true;
              }
              sendChunk({ content: delta.text });
            }
          }

          // Token usage
          if (type === "message_start") {
            const msg = event["message"] as { usage?: { input_tokens?: number } } | undefined;
            inputTokens = msg?.usage?.input_tokens ?? 0;
          }
          if (type === "message_delta") {
            const usage = event["usage"] as { output_tokens?: number } | undefined;
            outputTokens = usage?.output_tokens ?? 0;
          }
        }
      }

      // Send stop chunk
      if (!firstContentSent) {
        sendChunk({ role: "assistant", content: "" });
      }
      sendChunk({}, "stop", {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      });
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    // ── NON-STREAMING ──────────────────────────────────────────────────────
    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      logger.error({ status: anthropicRes.status, body: errText }, "Anthropic API error");
      res.status(anthropicRes.status).json({
        error: { message: errText, type: "upstream_error" },
      });
      return;
    }

    const data = (await anthropicRes.json()) as {
      content?: { type: string; text: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };

    const fullText = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({
      id: completionId,
      object: "chat.completion",
      created,
      model: anthropicModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullText },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "Proxy request failed");
    if (wantStream) {
      res.write(`data: [DONE]\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    }
  }
});

export default router;
