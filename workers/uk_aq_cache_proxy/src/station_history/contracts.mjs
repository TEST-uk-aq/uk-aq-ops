/**
 * Internal station-history contracts. These are deliberately framework-free so
 * they can move unchanged to the private station-history Worker in phase 2.
 */
export class RequestValidationError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "RequestValidationError";
    this.status = status;
    this.code = code;
  }
}

export class R2HistoryFetchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "R2HistoryFetchError";
    this.details = details;
  }
}

export const stationHistoryContractVersion = "v1";
