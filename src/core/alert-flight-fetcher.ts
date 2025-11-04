import type { Alert } from "@/db/schema";
import { Currency, MaxStops, SeatType, TripType } from "@/lib/fli/models";
import { logger } from "@/lib/logger";
import type { FlightFiltersInput } from "@/server/schemas/flight-filters";
import {
  type FlightOption,
  parseFlightFiltersInput,
  searchFlights,
} from "@/server/services/flights";
import type { AlertFilters } from "./filters";

/**
 * Efficient flight data fetching for alerts
 * Handles conversion of alert filters to flight search filters and batches searches
 */

export interface AlertWithFlights {
  alert: Alert;
  flights: FlightOption[];
}

/**
 * Converts alert filters to flight filters input for the search API
 * NOTE: For daily alerts, the date range (dateFrom/dateTo) represents a search window
 * for one-way flights, not specific round-trip dates.
 * @param alertFilters - Alert filters from database
 * @returns FlightFiltersInput for searchFlights or null if alert is expired
 */
function convertAlertFiltersToFlightFilters(
  alertFilters: AlertFilters,
): FlightFiltersInput | null {
  const { route, filters } = alertFilters;

  // Calculate date adjustments
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Use tomorrow to avoid timezone validation issues
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  // Check if entire date range has expired
  if (filters?.dateTo) {
    const endDate = new Date(filters.dateTo);
    endDate.setHours(0, 0, 0, 0);

    if (endDate < today) {
      logger.info("Alert date range has fully expired, skipping", {
        dateTo: filters.dateTo,
        today: today.toISOString().split("T")[0],
      });
      return null;
    }
  }

  // Adjust start date if it's in the past
  let effectiveDateFrom = filters?.dateFrom;
  if (effectiveDateFrom) {
    const startDate = new Date(effectiveDateFrom);
    startDate.setHours(0, 0, 0, 0);

    if (startDate < today) {
      effectiveDateFrom = tomorrowStr;
      logger.info("Alert start date has passed, adjusting search date", {
        originalDate: filters.dateFrom,
        adjustedDate: effectiveDateFrom,
      });
    }
  } else {
    effectiveDateFrom = tomorrowStr;
  }

  // Daily alerts always use ONE_WAY (date range is a search window, not round-trip dates)
  const tripType = TripType.ONE_WAY;

  // Single segment for one-way flight
  const segments = [
    {
      origin: route.from,
      destination: route.to,
      departureDate: effectiveDateFrom,
      departureTimeRange: filters?.departureTimeRange,
      arrivalTimeRange: filters?.arrivalTimeRange,
    },
  ];

  // Map alert Stops to MaxStops enum
  const stopsMap: Record<string, MaxStops> = {
    ANY: MaxStops.ANY,
    NONSTOP: MaxStops.NON_STOP,
    ONE_STOP: MaxStops.ONE_STOP_OR_FEWER,
    TWO_STOPS: MaxStops.TWO_OR_FEWER_STOPS,
  };
  const stops = filters?.stops
    ? (stopsMap[filters.stops] ?? MaxStops.ANY)
    : MaxStops.ANY;

  // Map alert SeatClass to SeatType enum
  const seatTypeMap: Record<string, SeatType> = {
    ECONOMY: SeatType.ECONOMY,
    PREMIUM_ECONOMY: SeatType.PREMIUM_ECONOMY,
    BUSINESS: SeatType.BUSINESS,
    FIRST: SeatType.FIRST,
  };
  const seatType = filters?.class
    ? (seatTypeMap[filters.class] ?? SeatType.ECONOMY)
    : SeatType.ECONOMY;

  // Use adjusted dates for the date range
  const input: FlightFiltersInput = {
    tripType,
    segments,
    dateRange: {
      from: effectiveDateFrom,
      to: filters?.dateTo || effectiveDateFrom,
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
 * Fetches flight data for a single alert
 * @param alert - Alert to fetch flights for
 * @param maxFlights - Maximum number of flights to return (default: 5)
 * @returns Alert with flight data or null if search fails
 */
async function fetchFlightsForAlert(
  alert: Alert,
  maxFlights = 5,
): Promise<AlertWithFlights | null> {
  try {
    // Convert alert filters to flight search input
    const flightFilters = convertAlertFiltersToFlightFilters(alert.filters);

    // Skip if date range has expired
    if (!flightFilters) {
      return null;
    }

    // Validate and parse the input
    const validatedFilters = parseFlightFiltersInput(flightFilters);

    // Search for flights
    const flights = await searchFlights(validatedFilters);

    // Limit to top N flights
    const limitedFlights = flights.slice(0, maxFlights);

    // Filter out flights that don't meet criteria
    const matchingFlights = filterFlightsByAlertCriteria(
      limitedFlights,
      alert.filters,
    );

    return {
      alert,
      flights: matchingFlights,
    };
  } catch (error) {
    logger.error("Failed to fetch flights for alert", {
      alertId: alert.id,
      error,
    });
    return null;
  }
}

/**
 * Filters flights based on additional alert criteria
 * @param flights - Array of flight options
 * @param alertFilters - Alert filters to apply
 * @returns Filtered array of flight options
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
    // Filter by max price
    if (filters.price && flight.totalPrice > filters.price) {
      return false;
    }

    // Filter by airlines (if specified)
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

    // Filter by stops
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
 * Groups alerts by route to enable potential batching
 * @param alerts - Array of alerts
 * @returns Map of route key to alerts
 */
function groupAlertsByRoute(alerts: Alert[]): Map<string, Alert[]> {
  const routeMap = new Map<string, Alert[]>();

  for (const alert of alerts) {
    const routeKey = `${alert.filters.route.from}-${alert.filters.route.to}`;
    const existing = routeMap.get(routeKey) || [];
    existing.push(alert);
    routeMap.set(routeKey, existing);
  }

  return routeMap;
}

/**
 * Fetches flight data for multiple alerts efficiently
 * @param alerts - Array of alerts to fetch flights for
 * @param maxFlights - Maximum number of flights per alert (default: 5)
 * @returns Array of alerts with their flight data
 */
export async function fetchFlightDataForAlerts(
  alerts: Alert[],
  maxFlights = 5,
): Promise<AlertWithFlights[]> {
  if (alerts.length === 0) {
    return [];
  }

  // Group alerts by route for potential optimization
  const routeGroups = groupAlertsByRoute(alerts);

  logger.info("Fetching flights for alerts", {
    alertCount: alerts.length,
    routeCount: routeGroups.size,
  });

  // Fetch flights for each alert in parallel
  const fetchPromises = alerts.map((alert) =>
    fetchFlightsForAlert(alert, maxFlights),
  );

  // Wait for all fetches to complete
  const results = await Promise.all(fetchPromises);

  // Filter out failed fetches and alerts with no flights
  const successfulResults = results.filter(
    (result): result is AlertWithFlights =>
      result !== null && result.flights.length > 0,
  );

  logger.info("Fetched flights for alerts", {
    alertCount: alerts.length,
    successfulCount: successfulResults.length,
  });

  return successfulResults;
}

/**
 * Fetches flight data for a single alert with error handling
 * @param alert - Alert to fetch flights for
 * @param maxFlights - Maximum number of flights (default: 5)
 * @returns Alert with flights or null on error
 */
export async function fetchFlightsForSingleAlert(
  alert: Alert,
  maxFlights = 5,
): Promise<AlertWithFlights | null> {
  return fetchFlightsForAlert(alert, maxFlights);
}
