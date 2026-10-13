import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async handler so a rejected promise reaches the Express error
 * handler instead of hanging the request. Every async route goes through this.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}