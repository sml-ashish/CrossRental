import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import * as reservations from "../services/reservations.service";
import type { ReservationActor } from "../services/reservations.service";

function actorOf(req: Request): ReservationActor {
  const user = (req as AuthedRequest).user;
  if (!user) throw AppError.unauthorized();
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    vendorId: user.vendorId,
  };
}

/**
 * Reservations (brief 5.3 / 6.1, phase B).
 *
 * The controller shapes HTTP and nothing else: the overlap rules, the derived
 * badge and the release email all live in the service, because the award flow
 * and the future admin screens call the same functions.
 */

export const index = asyncHandler(async (req: Request, res: Response) => {
  const list = await reservations.listReservations(req.query, actorOf(req));
  res.json({ reservations: list });
});

/** The booking calendar over a date range (BPD 6.17, P2). */
export const calendar = asyncHandler(async (req: Request, res: Response) => {
  const view = await reservations.bookingCalendar(req.query, actorOf(req));
  res.json({ calendar: view });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const created = await reservations.createBlockedReservation(req.body, actorOf(req));
  res.status(201).json({ reservation: created });
});

export const release = asyncHandler(async (req: Request, res: Response) => {
  const result = await reservations.releaseReservation(
    req.params.reservationId,
    req.body,
    actorOf(req),
  );
  res.json({ reservation: result.reservation, notified: result.notified });
});

export const completeOverdue = asyncHandler(async (_req: Request, res: Response) => {
  const completed = await reservations.completeOverdueReservations();
  res.json({ completed });
});
