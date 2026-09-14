export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(entity: string): ApiError {
  return new ApiError(404, "NOT_FOUND", `${entity} was not found`);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "CONFLICT", message);
}
