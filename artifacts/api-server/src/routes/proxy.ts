import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { Readable } from "node:stream";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VALID_TOKEN = "2222222222";

const MODELS = [
  { id: "claude-opus-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "anthropic" },
  { id: "claude-haiku-4-5", object: "model", created: 1700000000, owned_by: "anthropic" },
];

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  "gpt-4": "claude-sonnet-4-6",
  "gpt-4o": "claude-sonnet-4-6",
  "gpt-4o-mini": "claude-haiku-4-5",
  "gpt-3.5-turbo": "claude-haiku-4-5",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
};

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: { message: "Unauthorized", type: "auth_error", code: 401 } });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== VALID_TOKEN) {
    res.status(401).json({ error: { message: "Invalid token", type: "auth_error", code: 401 } });
    return;
  }
  next();
}

router.get("/models", authMiddleware, (_req: Request, res: Response) => {
  res.json({ object: "list", data: MODELS });
});

router.post("/chat/completions", authMiddleware, async (req: Request, res: Response) => {
  const body = req.body as {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
  };

  const requestedModel = body.model ?? "claude-sonnet-4-6";
  const anthropicModel = ANTHROPIC_MODEL_MAP[requestedModel] ?? "claude-sonnet-4-6";
  const messages = body.messages ?? [];
  const stream = body.stream ?? false;
  const maxTokens = body.max_tokens ?? 8192;

  const anthropicBaseUrl = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
  const anthropicApiKey = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];

  if (!anthropicBaseUrl || !anthropicApiKey) {
    res.status(500).json({ error: { message: "Anthropic integration not configured", type: "server_error" } });
    return;
  }

  const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
  const chatMessages = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

  const anthropicPayload: Record<string, unknown> = {
    model: anthropicModel,
    max_tokens: maxTokens,
    messages: chatMessages,
    ...(systemMessages ? { system: systemMessages } : {}),
  };

  if (!stream) {
    try {
      const anthropicRes = await fetch(`${anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicPayload),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        logger.error({ status: anthropicRes.status, body: errText }, "Anthropic API error");
        res.status(anthropicRes.status).json({ error: { message: errText, type: "api_error" } });
        return;
      }

      const data = await anthropicRes.json() as {
        id: string;
        content: Array<{ type: string; text?: string }>;
        model: string;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      const textContent = data.content.find(c => c.type === "text")?.text ?? "";
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: textContent }, finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason }],
        usage: { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens, total_tokens: data.usage.input_tokens + data.usage.output_tokens },
      });
    } catch (err) {
      logger.error({ err }, "Non-stream proxy error");
      if (!res.headersSent) res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    }
    return;
  }

  anthropicPayload["stream"] = true;

  let clientDisconnected = false;
  req.on("close", () => { clientDisconnected = true; });

  try {
    const anthropicRes = await fetch(`${anthropicBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicPayload),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      logger.error({ status: anthropicRes.status, body: errText }, "Anthropic streaming API error");
      res.status(anthropicRes.status).json({ error: { message: errText, type: "api_error" } });
      return;
    }

    if (!anthropicRes.body) {
      res.status(500).json({ error: { message: "No response body from Anthropic", type: "server_error" } });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.status(200);

    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    res.flushHeaders();

    const writeSSE = (data: string): void => {
      if (clientDisconnected || res.writableEnded) return;
      res.write(`data: ${data}\n\n`);
    };

    const requestId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const nodeStream = Readable.fromWeb(anthropicRes.body as Parameters<typeof Readable.fromWeb>[0]);
    let buffer = "";

    for await (const rawChunk of nodeStream) {
      if (clientDisconnected) break;

      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk.toString("utf-8")
        : typeof rawChunk === "string"
          ? rawChunk
          : Buffer.from(rawChunk as Uint8Array).toString("utf-8");

      buffer += chunk;

      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);

        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]") continue;

        let event: {
          type: string;
          delta?: { type: string; text?: string };
        };

        try {
          event = JSON.parse(jsonStr) as typeof event;
        } catch {
          continue;
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          writeSSE(JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
          }));
        } else if (event.type === "message_stop") {
          writeSSE(JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }));
          writeSSE("[DONE]");
        }
      }
    }

    if (!clientDisconnected && !res.writableEnded) {
      res.end();
    }
  } catch (err) {
    logger.error({ err }, "Stream proxy error");
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

export default router;
