import { AccountApiError } from "../account-api.js";
import { ClientError as CliError } from "../client-error.js";

const redact = (value: string) => value.replace(/hailp_[A-Za-z0-9_-]{43}/g, "[REDACTED]");

export function printResult(result: unknown): void {
  console.info(redact(JSON.stringify({ ...result as Record<string, unknown>, cliContractVersion: 1 })));
}

export function printError(error: unknown): void {
  console.error(redact(JSON.stringify({ cliContractVersion: 1, error: {
    code: error instanceof AccountApiError ? `HTTP_${error.status}` : error instanceof CliError ? error.code : "CLIENT_ERROR",
    message: error instanceof Error ? error.message : "Client operation failed",
    ...(error instanceof AccountApiError ? { httpStatus: error.status, retryable: error.status === 429 || error.status === 503,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) } : {}),
  } })));
}
