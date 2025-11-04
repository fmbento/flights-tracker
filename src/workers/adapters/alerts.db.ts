/**
 * Adapter for alerts-db to work in Cloudflare Worker environment
 * Wraps existing src/core/alerts-db.ts functions with worker DB instance
 */

import { and, eq, gte, isNull, or } from "drizzle-orm";
import { AlertType } from "@/core/alert-types";
import type { UpdateAlertInput } from "@/core/types";
import { type Alert, airport, alert } from "@/db/schema";
import { getWorkerDb } from "../db";
import type { WorkerEnv } from "../env";

export async function getUserIdsWithActiveDailyAlerts(
  env: WorkerEnv,
): Promise<string[]> {
  const db = getWorkerDb(env);
  const now = new Date().toISOString();

  const results = await db
    .select({ userId: alert.userId })
    .from(alert)
    .where(
      and(
        eq(alert.status, "active"),
        eq(alert.type, AlertType.DAILY),
        or(isNull(alert.alertEnd), gte(alert.alertEnd, now)),
      ),
    )
    .groupBy(alert.userId);

  return results.map((row) => row.userId);
}

/**
 * Checks if a user has active daily alerts
 */
export async function userHasActiveAlerts(
  env: WorkerEnv,
  userId: string,
): Promise<boolean> {
  const db = getWorkerDb(env);
  const now = new Date().toISOString();

  const result = await db
    .select({ count: alert.id })
    .from(alert)
    .where(
      and(
        eq(alert.userId, userId),
        eq(alert.status, "active"),
        eq(alert.type, AlertType.DAILY),
        or(isNull(alert.alertEnd), gte(alert.alertEnd, now)),
      ),
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Retrieves all alerts for a specific user
 * @param env - Worker environment
 * @param userId - The user ID
 * @param status - Optional status filter
 * @returns Array of alerts
 */
export async function getAlertsByUser(
  env: WorkerEnv,
  userId: string,
  status?: "active" | "completed" | "deleted",
): Promise<Alert[]> {
  const db = getWorkerDb(env);
  const conditions = [eq(alert.userId, userId)];

  if (status) {
    conditions.push(eq(alert.status, status));
  }

  return await db
    .select()
    .from(alert)
    .where(and(...conditions))
    .orderBy(alert.createdAt);
}

/**
 * Updates an existing alert
 * @param env - Worker environment
 * @param alertId - The alert ID
 * @param updates - Fields to update
 * @returns The updated alert if found, null otherwise
 */
export async function updateAlert(
  env: WorkerEnv,
  alertId: string,
  updates: UpdateAlertInput,
): Promise<Alert | null> {
  const db = getWorkerDb(env);
  const result = await db
    .update(alert)
    .set(updates)
    .where(eq(alert.id, alertId))
    .returning();

  return result[0] || null;
}

/**
 * Gets airport information by IATA code
 * @param env - Worker environment
 * @param iataCode - The airport IATA code
 * @returns Airport information if found, null otherwise
 */
export async function getAirportByIata(env: WorkerEnv, iataCode: string) {
  const db = getWorkerDb(env);
  const result = await db
    .select()
    .from(airport)
    .where(eq(airport.iata, iataCode.toUpperCase()))
    .limit(1);

  return result[0] || null;
}
