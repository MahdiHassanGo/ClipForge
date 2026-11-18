import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  AuthorizationError,
  InvalidStateTransitionError,
  YouTubeUrlValidationError,
  createLogger,
} from "@clipforge/core";

const logger = createLogger("clipforge-web");

export function handleApiError(error: unknown, context?: Record<string, unknown>) {
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.statusCode },
    );
  }

  if (error instanceof YouTubeUrlValidationError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: 400 },
    );
  }

  if (error instanceof InvalidStateTransitionError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: 409 },
    );
  }

  if (error instanceof ZodError) {
    const first = error.issues[0];
    return NextResponse.json(
      {
        error: first?.message ?? "Invalid request payload.",
        code: "VALIDATION_ERROR",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  logger.error("Unhandled API error", { error, ...context });
  return NextResponse.json(
    {
      error: "An unexpected server error occurred. Please try again.",
      code: "INTERNAL_ERROR",
    },
    { status: 500 },
  );
}

/**
 * Recursively converts BigInt and Date values into JSON-safe primitives.
 */
export function serializeJson<T>(data: T): unknown {
  return JSON.parse(
    JSON.stringify(data, (_key, value) => {
      if (typeof value === "bigint") return Number(value);
      return value;
    }),
  );
}
