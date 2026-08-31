export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unauthorized = (message = "Authentication required") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "Forbidden") => new AppError(403, "forbidden", message);
export const notFound = () => new AppError(404, "not_found", "Resource not found");
export const conflict = (code, message) => new AppError(409, code, message);
export const serviceUnavailable = (code, message) => new AppError(503, code, message);
