#!/usr/bin/env bun

/**
 * Local email generation tester
 * Tests the complete email notification flow without actually sending emails
 *
 * Usage: dotenv -- bun run scripts/generate-email-to-user.ts <user-id>
 */

import { createClient } from "@supabase/supabase-js";
import { AlertType } from "@/core/alert-types";
import {
  getAirportByIata,
  getAlertsByUser,
  updateAlert,
} from "@/core/alerts.db";
import type { AlertFilters } from "@/core/filters";
import {
  hasAlertBeenProcessedRecently,
  hasUserReceivedEmailToday,
} from "@/core/notifications.db";
import type { Alert } from "@/db/schema";
import { Currency, MaxStops, SeatType, TripType } from "@/lib/fli/models";
import { generateDailyDigestBlueprint } from "@/lib/notifications/ai-email-agent";
import { buildDailyDigestBlueprintContext } from "@/lib/notifications/ai-email-context";
import { renderDailyPriceUpdateEmail } from "@/lib/notifications/templates/daily-price-update";
import type {
  AlertDescriptor,
  DailyAlertSummary,
  DailyPriceUpdateEmail,
} from "@/lib/notifications/types";
import type { FlightFiltersInput } from "@/server/schemas/flight-filters";
import {
  type FlightOption,
  parseFlightFiltersInput,
  searchFlights,
} from "@/server/services/flights";
import { getArgs } from "./utils/args";

const DEDUPLICATION_HOURS = 23;
const MAX_FLIGHTS_PER_ALERT = 5;

interface AlertWithFlights {
  alert: Alert;
  flights: FlightOption[];
}

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log("\n");
  log("=".repeat(80), colors.cyan);
  log(`  ${title}`, colors.bright + colors.cyan);
  log("=".repeat(80), colors.cyan);
  console.log();
}

function logSubsection(title: string) {
  console.log();
  log(`── ${title}`, colors.blue);
}

function parseArgs() {
  const args = getArgs();
  const [userId] = args;

  if (!userId) {
    console.error(
      "Usage: dotenv -- bun run scripts/generate-email-to-user.ts <user-id>",
    );
    process.exit(1);
  }

  return { userId };
}

async function getUserEmail(userId: string): Promise<string | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase environment variables");
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data.user?.email) {
    return null;
  }

  return data.user.email;
}

async function filterAndUpdateExpiredAlerts(alerts: Alert[]): Promise<Alert[]> {
  const now = new Date();
  const activeAlerts: Alert[] = [];
  const expiredAlerts: Alert[] = [];

  for (const alert of alerts) {
    if (alert.alertEnd) {
      const endDate = new Date(alert.alertEnd);
      if (endDate <= now) {
        expiredAlerts.push(alert);
      } else {
        activeAlerts.push(alert);
      }
    } else {
      activeAlerts.push(alert);
    }
  }

  if (expiredAlerts.length > 0) {
    log(
      `  Marking ${expiredAlerts.length} expired alerts as completed`,
      colors.yellow,
    );
    await Promise.all(
      expiredAlerts.map((alert) =>
        updateAlert(alert.id, { status: "completed" }),
      ),
    );
  }

  return activeAlerts;
}

async function filterUnprocessedAlerts(alerts: Alert[]): Promise<Alert[]> {
  const results = await Promise.all(
    alerts.map(async (alert) => ({
      alert,
      processed: await hasAlertBeenProcessedRecently(
        alert.id,
        DEDUPLICATION_HOURS,
      ),
    })),
  );

  return results.filter((r) => !r.processed).map((r) => r.alert);
}

async function convertAlertToDescriptor(
  alert: Alert,
): Promise<AlertDescriptor> {
  const { route, filters } = alert.filters;

  const [fromAirport, toAirport] = await Promise.all([
    getAirportByIata(route.from),
    getAirportByIata(route.to),
  ]);

  const fromName = fromAirport
    ? `${fromAirport.city} (${fromAirport.iata})`
    : route.from;
  const toName = toAirport ? `${toAirport.city} (${toAirport.iata})` : route.to;

  const descriptor: AlertDescriptor = {
    id: alert.id,
    label: `${fromName} to ${toName}`,
    origin: fromName,
    destination: toName,
  };

  if (filters?.class) {
    descriptor.seatType = filters.class
      .split("_")
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(" ");
  }

  if (filters?.stops) {
    descriptor.stops =
      filters.stops === "NONSTOP"
        ? "Nonstop"
        : filters.stops === "ONE_STOP"
          ? "1 stop max"
          : filters.stops === "TWO_STOPS"
            ? "2 stops max"
            : "Any stops";
  }

  if (filters?.airlines && filters.airlines.length > 0) {
    descriptor.airlines = filters.airlines;
  }

  if (filters?.price) {
    descriptor.priceLimit = {
      amount: filters.price,
      currency: "USD",
    };
  }

  return descriptor;
}

async function formatAlertsForEmail(
  alertsWithFlights: AlertWithFlights[],
): Promise<DailyAlertSummary[]> {
  const summaries = await Promise.all(
    alertsWithFlights.map(async ({ alert, flights }) => ({
      alert: await convertAlertToDescriptor(alert),
      flights,
      generatedAt: new Date().toISOString(),
    })),
  );

  return summaries;
}

/**
 * Convert alert filters to flight search input (modified for daily alerts)
 * NOTE: For daily alerts, date range represents a search window, not round-trip dates.
 * We search for ONE-WAY flights only.
 */
function convertAlertFiltersToFlightFilters(
  alertFilters: AlertFilters,
): FlightFiltersInput {
  const { route, filters } = alertFilters;

  // Daily alerts always use ONE_WAY (date range is a search window, not round-trip dates)
  const tripType = TripType.ONE_WAY;

  // Single segment for one-way flight
  const segments = [
    {
      origin: route.from,
      destination: route.to,
      departureDate: filters?.dateFrom,
      departureTimeRange: filters?.departureTimeRange,
      arrivalTimeRange: filters?.arrivalTimeRange,
    },
  ];

  const stopsMap: Record<string, MaxStops> = {
    ANY: MaxStops.ANY,
    NONSTOP: MaxStops.NON_STOP,
    ONE_STOP: MaxStops.ONE_STOP_OR_FEWER,
    TWO_STOPS: MaxStops.TWO_OR_FEWER_STOPS,
  };
  const stops = filters?.stops
    ? (stopsMap[filters.stops] ?? MaxStops.ANY)
    : MaxStops.ANY;

  const seatTypeMap: Record<string, SeatType> = {
    ECONOMY: SeatType.ECONOMY,
    PREMIUM_ECONOMY: SeatType.PREMIUM_ECONOMY,
    BUSINESS: SeatType.BUSINESS,
    FIRST: SeatType.FIRST,
  };
  const seatType = filters?.class
    ? (seatTypeMap[filters.class] ?? SeatType.ECONOMY)
    : SeatType.ECONOMY;

  // For one-way flights, use single departure date for both from/to
  const departureDate =
    filters?.dateFrom || new Date().toISOString().split("T")[0];

  const input: FlightFiltersInput = {
    tripType,
    segments,
    dateRange: {
      from: departureDate,
      to: departureDate, // Same date for one-way search
    },
    seatType,
    stops,
  };

  if (filters?.airlines && filters.airlines.length > 0) {
    input.airlines = filters.airlines;
  }

  if (filters?.price) {
    input.priceLimit = {
      amount: filters.price,
      currency: Currency.USD,
    };
  }

  return input;
}

/**
 * Filter flights by alert criteria (copied from alert-flight-fetcher.ts)
 */
function filterFlightsByAlertCriteria(
  flights: FlightOption[],
  alertFilters: AlertFilters,
): FlightOption[] {
  const { filters } = alertFilters;

  if (!filters) {
    return flights;
  }

  return flights.filter((flight) => {
    if (filters.price && flight.totalPrice > filters.price) {
      return false;
    }

    if (filters.airlines && filters.airlines.length > 0) {
      const allowedAirlines = new Set(
        filters.airlines.map((code) => code.toUpperCase()),
      );
      const hasMatchingAirline = flight.slices.some((slice) =>
        slice.legs.some((leg) => allowedAirlines.has(leg.airlineCode)),
      );
      if (!hasMatchingAirline) {
        return false;
      }
    }

    if (filters.stops) {
      const maxStops =
        filters.stops === "NONSTOP"
          ? 0
          : filters.stops === "ONE_STOP"
            ? 1
            : filters.stops === "TWO_STOPS"
              ? 2
              : Number.POSITIVE_INFINITY;

      const hasValidStops = flight.slices.every(
        (slice) => slice.stops <= maxStops,
      );
      if (!hasValidStops) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Verbose flight fetching that logs all details and errors
 */
async function fetchFlightDataVerbose(
  alerts: Alert[],
  maxFlights: number,
): Promise<AlertWithFlights[]> {
  const results: AlertWithFlights[] = [];

  log(`\n  Processing ${alerts.length} alerts...`, colors.dim);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Use tomorrow for searches to avoid timezone validation issues
  // FlightSegmentSchema compares "2025-11-04" (UTC midnight) against
  // new Date().setHours(0,0,0,0) (local midnight), which can fail in timezones behind UTC
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    const { route, filters } = alert.filters;

    log(
      `\n  [${i + 1}/${alerts.length}] Alert ${alert.id.substring(0, 12)}... - ${route.from} → ${route.to}`,
      colors.cyan,
    );

    // Show filter details
    const dateLabel = filters?.dateFrom
      ? filters?.dateTo && filters.dateTo !== filters.dateFrom
        ? `${filters.dateFrom} to ${filters.dateTo}`
        : filters.dateFrom
      : "NO DATE SET";

    log(`    Dates: ${dateLabel}`, colors.dim);
    log(
      `    Class: ${filters?.class || "Any"} | Stops: ${filters?.stops || "Any"}`,
      colors.dim,
    );
    log(
      `    Airlines: ${filters?.airlines?.join(", ") || "Any"} | Price: ${filters?.price ? `$${filters.price}` : "Any"}`,
      colors.dim,
    );

    // Check if date is set
    if (!filters?.dateFrom) {
      log(
        `    ✗ Skipping - No departure date set in alert filters`,
        colors.yellow,
      );
      continue;
    }

    // For daily alerts with date ranges, check if the range is still active
    const startDate = new Date(filters.dateFrom);
    startDate.setHours(0, 0, 0, 0);

    let endDate: Date | null = null;
    if (filters?.dateTo) {
      endDate = new Date(filters.dateTo);
      endDate.setHours(0, 0, 0, 0);
    }

    // Check if entire date range has passed
    if (endDate && endDate < today) {
      log(
        `    ✗ Skipping - Alert end date ${filters.dateTo} is in the past`,
        colors.yellow,
      );
      continue;
    }

    // If start date is in the past but end date is future, we need to adjust
    let modifiedAlert = alert;
    if (startDate < today && endDate && endDate >= today) {
      log(
        `    ℹ️  Start date ${filters.dateFrom} has passed, searching from ${tomorrowStr} onwards`,
        colors.blue,
      );
      log(
        `       (Using tomorrow to avoid timezone validation issues)`,
        colors.dim,
      );

      // Create a modified alert with adjusted date
      // Use tomorrow instead of today to avoid timezone comparison issues
      modifiedAlert = {
        ...alert,
        filters: {
          ...alert.filters,
          filters: {
            ...filters,
            dateFrom: tomorrowStr,
          },
        },
      };
    } else if (startDate < today && !endDate) {
      // No end date and start date is past
      log(
        `    ✗ Skipping - Departure date ${filters.dateFrom} is in the past (no end date)`,
        colors.yellow,
      );
      continue;
    }

    try {
      // Step 1: Convert alert filters to flight filters
      log(`    Step 1: Converting filters...`, colors.dim);
      const flightFilters = convertAlertFiltersToFlightFilters(
        modifiedAlert.filters,
      );

      log(
        `      Trip type: ${flightFilters.tripType === TripType.ONE_WAY ? "One-way" : "Round-trip"}`,
        colors.dim,
      );
      log(
        `      Search dates: ${flightFilters.dateRange.from} to ${flightFilters.dateRange.to}`,
        colors.dim,
      );
      log(`      Seat type: ${flightFilters.seatType}`, colors.dim);
      log(`      Max stops: ${flightFilters.stops}`, colors.dim);

      // Step 2: Validate and parse
      log(`    Step 2: Validating filters...`, colors.dim);
      const validatedFilters = parseFlightFiltersInput(flightFilters);
      log(`      ✓ Filters validated`, colors.green);

      // Step 3: Search for flights
      log(`    Step 3: Calling FLI SDK...`, colors.dim);
      const rawFlights = await searchFlights(validatedFilters);
      log(`      Raw results: ${rawFlights.length} flights`, colors.cyan);

      if (rawFlights.length === 0) {
        log(
          `      ℹ️  FLI SDK returned 0 flights for this route/date`,
          colors.yellow,
        );
        continue;
      }

      // Step 4: Apply limit
      const limitedFlights = rawFlights.slice(0, maxFlights);
      if (rawFlights.length > maxFlights) {
        log(
          `      Limited to ${maxFlights} flights (from ${rawFlights.length})`,
          colors.dim,
        );
      }

      // Step 5: Filter by alert criteria
      log(`    Step 4: Filtering by alert criteria...`, colors.dim);
      const matchingFlights = filterFlightsByAlertCriteria(
        limitedFlights,
        modifiedAlert.filters,
      );

      const filteredOut = limitedFlights.length - matchingFlights.length;
      if (filteredOut > 0) {
        log(
          `      Filtered out ${filteredOut} flights (price/airline/stops)`,
          colors.yellow,
        );
      }

      if (matchingFlights.length > 0) {
        log(
          `    ✓ Final result: ${matchingFlights.length} matching flights`,
          colors.green,
        );
        results.push({
          alert: alert,
          flights: matchingFlights,
        });
      } else {
        log(
          `    ⚠️  All flights filtered out (no matches after criteria applied)`,
          colors.yellow,
        );
      }
    } catch (error) {
      log(
        `    ✗ Error: ${error instanceof Error ? error.message : String(error)}`,
        colors.red,
      );

      // If it's a FlightFiltersValidationError, show detailed Zod issues
      if (error && typeof error === "object" && "issues" in error) {
        const issues = (error as { issues: unknown[] }).issues;
        log(`\n      Validation Issues:`, colors.yellow);
        for (const issue of issues) {
          const typedIssue = issue as {
            path?: (string | number)[];
            message?: string;
            code?: string;
          };
          const path = typedIssue.path?.join(".") || "root";
          log(`        - ${path}: ${typedIssue.message}`, colors.yellow);
        }
      }

      if (error instanceof Error && error.stack) {
        log(
          `\n      Stack: ${error.stack.split("\n").slice(0, 3).join("\n      ")}`,
          colors.dim,
        );
      }
    }
  }

  return results;
}

async function main() {
  const { userId } = parseArgs();

  logSection("EMAIL GENERATION TEST - LOCAL MODE");
  log(`User ID: ${userId}`, colors.bright);

  // Display system date for debugging
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  log(`\nSystem Date & Time:`, colors.dim);
  log(`  ISO: ${now.toISOString()}`, colors.dim);
  log(`  Local: ${now.toLocaleString()}`, colors.dim);
  log(`  Today: ${now.toISOString().split("T")[0]}`, colors.bright);
  log(
    `  Tomorrow: ${tomorrow.toISOString().split("T")[0]} (used for flight searches)`,
    colors.dim,
  );

  try {
    // Step 1: Check email eligibility
    logSubsection("Step 1: Checking Email Eligibility");
    const receivedToday = await hasUserReceivedEmailToday(userId);
    if (receivedToday) {
      log(
        "  ⚠️  User already received email today (would be skipped in production)",
        colors.yellow,
      );
    } else {
      log("  ✓ User is eligible for email", colors.green);
    }

    // Step 2: Get user email
    logSubsection("Step 2: Fetching User Email");
    const userEmail = await getUserEmail(userId);
    if (!userEmail) {
      log("  ✗ No email found for user", colors.red);
      process.exit(1);
    }
    log(`  Email: ${userEmail}`, colors.green);

    // Step 3: Get active daily alerts
    logSubsection("Step 3: Fetching Active Daily Alerts");
    const allAlerts = await getAlertsByUser(userId, "active");
    const dailyAlerts = allAlerts.filter(
      (alert) => alert.type === AlertType.DAILY,
    );
    log(`  Total alerts: ${allAlerts.length}`, colors.dim);
    log(`  Daily alerts: ${dailyAlerts.length}`, colors.green);

    if (dailyAlerts.length === 0) {
      log("  ✗ No daily alerts found", colors.red);
      process.exit(0);
    }

    // Display alert details
    for (const alert of dailyAlerts) {
      const { route, filters } = alert.filters;
      const classLabel = filters?.class || "Any";
      const priceLabel = filters?.price ? `$${filters.price}` : "Any";
      const dateLabel = filters?.dateFrom
        ? filters?.dateTo && filters.dateTo !== filters.dateFrom
          ? `${filters.dateFrom} to ${filters.dateTo}`
          : filters.dateFrom
        : "No date";
      const stopsLabel = filters?.stops || "Any";

      log(
        `    Alert ${alert.id.substring(0, 12)}... | ${route.from} → ${route.to}`,
        colors.dim,
      );
      log(`      Dates: ${dateLabel}`, colors.dim);
      log(
        `      Class: ${classLabel} | Stops: ${stopsLabel} | Price: ${priceLabel}`,
        colors.dim,
      );
    }

    // Step 4: Filter expired alerts
    logSubsection("Step 4: Filtering Expired Alerts");
    const nonExpiredAlerts = await filterAndUpdateExpiredAlerts(dailyAlerts);
    log(`  Non-expired alerts: ${nonExpiredAlerts.length}`, colors.green);

    if (nonExpiredAlerts.length === 0) {
      log("  ✗ All alerts expired", colors.red);
      process.exit(0);
    }

    // Step 5: Filter recently processed alerts
    logSubsection("Step 5: Filtering Recently Processed Alerts");
    const alertsToProcess = await filterUnprocessedAlerts(nonExpiredAlerts);
    log(
      `  Unprocessed alerts (last ${DEDUPLICATION_HOURS}h): ${alertsToProcess.length} / ${nonExpiredAlerts.length}`,
      colors.green,
    );

    if (alertsToProcess.length === 0) {
      log("  ✗ All alerts recently processed", colors.yellow);
      log(
        `  Note: Alerts are deduplicated within ${DEDUPLICATION_HOURS} hours`,
        colors.dim,
      );
      process.exit(0);
    }

    // Show which alerts will be processed
    log(`\n  Alerts to process:`, colors.dim);
    for (const alert of alertsToProcess) {
      const { route } = alert.filters;
      log(
        `    - ${alert.id.substring(0, 12)}... | ${route.from} → ${route.to}`,
        colors.dim,
      );
    }

    // Step 6: Fetch flight data
    logSubsection("Step 6: Fetching Flight Data (Verbose Mode)");
    log(`  Max flights per alert: ${MAX_FLIGHTS_PER_ALERT}`, colors.dim);

    const alertsWithFlights = await fetchFlightDataVerbose(
      alertsToProcess,
      MAX_FLIGHTS_PER_ALERT,
    );

    log(
      `\n  ✓ Alerts with matching flights: ${alertsWithFlights.length} / ${alertsToProcess.length}`,
      alertsWithFlights.length > 0 ? colors.green : colors.yellow,
    );

    if (alertsWithFlights.length === 0) {
      log("  ✗ No matching flights found", colors.yellow);
      process.exit(0);
    }

    // Display flight data
    logSection("FLIGHT DATA");
    for (const { alert, flights } of alertsWithFlights) {
      const { route } = alert.filters;
      log(`\n${route.from} → ${route.to}`, colors.bright + colors.magenta);
      log(`Alert ID: ${alert.id}`, colors.dim);
      log(`Flights found: ${flights.length}`, colors.green);

      for (let i = 0; i < flights.length; i++) {
        const flight = flights[i];
        const slice = flight.slices[0];
        const firstLeg = slice.legs[0];
        const lastLeg = slice.legs[slice.legs.length - 1];

        log(`\n  Flight ${i + 1}:`, colors.cyan);
        log(
          `    Price: ${flight.currency} ${flight.totalPrice}`,
          colors.bright,
        );
        log(`    Duration: ${slice.durationMinutes} minutes`, colors.dim);
        log(`    Stops: ${slice.stops}`, colors.dim);
        log(
          `    Departure: ${firstLeg.departureAirportCode} at ${new Date(firstLeg.departureDateTime).toLocaleString()}`,
          colors.dim,
        );
        log(
          `    Arrival: ${lastLeg.arrivalAirportCode} at ${new Date(lastLeg.arrivalDateTime).toLocaleString()}`,
          colors.dim,
        );
        log(
          `    Airlines: ${slice.legs.map((l) => l.airlineCode).join(", ")}`,
          colors.dim,
        );
      }
    }

    // Step 7: Format alerts for email
    logSubsection("Step 7: Formatting Alerts for Email");
    const alertSummaries = await formatAlertsForEmail(alertsWithFlights);

    const payload: DailyPriceUpdateEmail = {
      type: "daily-price-update",
      summaryDate: new Date().toISOString().split("T")[0],
      alerts: alertSummaries,
    };

    log(`  Email payload created`, colors.green);
    log(`  Summary date: ${payload.summaryDate}`, colors.dim);
    log(`  Alerts in payload: ${payload.alerts.length}`, colors.dim);

    // Step 8: Build AI context
    logSubsection("Step 8: Building AI Context");
    const aiContext = buildDailyDigestBlueprintContext(payload);

    logSection("AI CONTEXT");
    log(JSON.stringify(aiContext, null, 2), colors.cyan);

    // Step 9: Generate AI blueprint
    logSubsection("Step 9: Generating AI Blueprint");
    let blueprint = null;

    try {
      if (!process.env.AI_GATEWAY_API_KEY) {
        log(
          "  ⚠️  AI_GATEWAY_API_KEY not set - skipping AI generation",
          colors.yellow,
        );
      } else {
        log("  Calling AI service...", colors.dim);
        blueprint = await generateDailyDigestBlueprint(aiContext);

        if (blueprint) {
          log("  ✓ AI blueprint generated successfully", colors.green);

          logSection("AI BLUEPRINT");
          log(JSON.stringify(blueprint, null, 2), colors.magenta);
        } else {
          log(
            "  ⚠️  AI generation returned null (using fallback)",
            colors.yellow,
          );
        }
      }
    } catch (error) {
      log(
        `  ⚠️  AI generation failed: ${error instanceof Error ? error.message : String(error)}`,
        colors.yellow,
      );
      log("  Will use fallback email template", colors.dim);
    }

    // Step 10: Render email
    logSubsection("Step 10: Rendering Email HTML");
    const emailContent = renderDailyPriceUpdateEmail(
      payload,
      blueprint ? { blueprint } : undefined,
    );

    logSection("EMAIL CONTENT");
    log(`\nSubject: ${emailContent.subject}`, colors.bright + colors.green);
    log(`\nHTML Preview (first 1250 chars):`, colors.dim);
    log("-".repeat(80), colors.dim);
    log(`${emailContent.html.substring(0, 1250)}...`, colors.cyan);
    log("-".repeat(80), colors.dim);

    log(`\nText Version (first 1250 chars):`, colors.dim);
    log("-".repeat(80), colors.dim);
    log(`${emailContent.text.substring(0, 1250)}...`, colors.cyan);
    log("-".repeat(80), colors.dim);

    // Summary
    logSection("SUMMARY");
    log(`✓ User: ${userEmail}`, colors.green);
    log(`✓ Alerts processed: ${alertsWithFlights.length}`, colors.green);
    log(
      `✓ Total flights found: ${alertsWithFlights.reduce((sum, a) => sum + a.flights.length, 0)}`,
      colors.green,
    );
    log(
      `✓ AI blueprint: ${blueprint ? "Generated" : "Fallback used"}`,
      blueprint ? colors.green : colors.yellow,
    );
    log(`✓ Email subject: ${emailContent.subject}`, colors.green);
    log(`✓ Email HTML length: ${emailContent.html.length} chars`, colors.green);
    log(`✓ Email text length: ${emailContent.text.length} chars`, colors.green);
    log(`\n✓ Email NOT sent (local test mode)`, colors.bright + colors.yellow);

    console.log();
  } catch (error) {
    logSection("ERROR");
    log(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
      colors.red,
    );
    if (error instanceof Error && error.stack) {
      log(`\nStack trace:`, colors.dim);
      log(error.stack, colors.dim);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
