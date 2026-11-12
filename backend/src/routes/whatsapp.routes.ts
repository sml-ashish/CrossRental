import express, { Router } from "express";
import * as whatsapp from "../controllers/whatsapp.controller";

const router = Router();

/**
 * Mounted before the JSON parser in `index.ts`: Meta signs the raw bytes, so
 * this route must see the body untouched.
 */
router.get("/webhook", whatsapp.verify);
router.post("/webhook", express.raw({ type: "application/json", limit: "2mb" }), whatsapp.receive);

export default router;
