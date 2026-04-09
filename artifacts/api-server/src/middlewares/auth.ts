import { type Request, type Response, type NextFunction } from "express";

const VALID_TOKEN = "2222222222";

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
    return;
  }
  const token = authHeader.slice(7).trim();
  if (token !== VALID_TOKEN) {
    res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
    return;
  }
  next();
}
