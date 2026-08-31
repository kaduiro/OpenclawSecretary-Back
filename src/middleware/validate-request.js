import Ajv from "ajv";
import addFormats from "ajv-formats";
import { badRequest } from "../lib/errors.js";

const ajv = new Ajv({ allErrors: true, coerceTypes: true, removeAdditional: false, allowUnionTypes: true });
addFormats(ajv);

function errorDetails(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => ({
    path: instancePath || "/",
    keyword,
    message,
    params,
  }));
}

export function validateRequest({ body, query } = {}) {
  const validateBody = body ? ajv.compile(body) : undefined;
  const validateQuery = query ? ajv.compile(query) : undefined;
  return (req, _res, next) => {
    try {
      const bodyValue = req.body === undefined && !Array.isArray(body?.required) ? {} : req.body;
      if (validateBody && !validateBody(bodyValue)) {
        throw badRequest("invalid_request_body", "Request body does not match the API contract", errorDetails(validateBody.errors));
      }
      if (validateBody) req.body = bodyValue;
      if (validateQuery && !validateQuery(req.query)) {
        throw badRequest("invalid_query", "Query parameters do not match the API contract", errorDetails(validateQuery.errors));
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const schemas = Object.freeze({
  limitQuery: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", minLength: 1 } },
  },
  limitBody: {
    type: "object",
    additionalProperties: false,
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
  },
  transfer: {
    type: "object",
    required: ["targetAttendeeRef"],
    additionalProperties: false,
    properties: { targetAttendeeRef: { type: "string", format: "uuid" } },
  },
  approval: {
    type: "object",
    required: ["approvalToken", "cardVersion"],
    additionalProperties: false,
    properties: {
      approvalToken: { type: "string", minLength: 43, maxLength: 128 },
      cardVersion: { type: "integer", minimum: 1 },
    },
  },
  faq: {
    type: "object",
    required: ["question", "answer", "piiReviewed"],
    additionalProperties: false,
    properties: {
      faqCandidateId: { type: ["string", "null"], format: "uuid" },
      sourceMailId: { type: ["string", "null"], format: "uuid" },
      question: { type: "string", minLength: 1, maxLength: 1000 },
      answer: { type: "string", minLength: 1, maxLength: 8000 },
      piiReviewed: { const: true },
    },
  },
  adminUser: {
    type: "object",
    required: ["email", "businessUnitRef"],
    additionalProperties: false,
    properties: {
      email: { type: "string", format: "email", maxLength: 320 },
      businessUnitRef: { type: "string", format: "uuid" },
      role: { enum: ["member", "manager", "faq_reviewer"] },
    },
  },
  businessUnit: {
    type: "object",
    required: ["name", "calendarAccount"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      calendarAccount: { type: "string", format: "email", maxLength: 320 },
    },
  },
  handoffRedeem: {
    type: "object",
    required: ["handoffCode", "handoffVerifier"],
    additionalProperties: false,
    properties: {
      handoffCode: { type: "string", minLength: 43 },
      handoffVerifier: { type: "string", minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" },
    },
  },
  oauthSession: {
    type: "object",
    required: ["returnUri", "handoffChallenge"],
    additionalProperties: false,
    properties: {
      returnUri: { type: "string", format: "uri" },
      handoffChallenge: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    },
  },
  oauthExchange: {
    type: "object",
    required: ["code", "state"],
    additionalProperties: false,
    properties: { code: { type: "string", minLength: 1 }, state: { type: "string", minLength: 43 } },
  },
  calendarApproval: {
    type: "object",
    required: ["approvalToken", "cardVersion", "selectedSlotId"],
    additionalProperties: false,
    properties: {
      approvalToken: { type: "string", minLength: 43 },
      cardVersion: { type: "integer", minimum: 1 },
      selectedSlotId: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  calendarRejection: {
    type: "object",
    required: ["approvalToken", "cardVersion", "rejectionReasonCode"],
    additionalProperties: false,
    properties: {
      approvalToken: { type: "string", minLength: 43 },
      cardVersion: { type: "integer", minimum: 1 },
      rejectionReasonCode: { enum: ["no_common_slot", "poor_context", "outside_requested_period", "needs_more_options", "missing_participant", "manual_review_requested", "other_non_pii"] },
      rejectionReasonDetail: { type: ["string", "null"], maxLength: 500 },
      rejectedSlotIds: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 80 } },
      preferredWindows: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          required: ["start", "end"],
          additionalProperties: false,
          properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } },
        },
      },
    },
  },
  calendarAlternative: {
    type: "object",
    required: ["replanReasonCode"],
    additionalProperties: false,
    properties: {
      replanReasonCode: { enum: ["expand_period", "reduce_attendees", "avoid_high_priority_neighbors", "prefer_earlier", "prefer_later", "selection_conflict", "manual_review_requested", "other_non_pii"] },
      requestedWindowStart: { type: ["string", "null"], format: "date-time" },
      requestedWindowEnd: { type: ["string", "null"], format: "date-time" },
      constraintReasonCodes: { type: "array", items: { type: "string" }, maxItems: 20 },
    },
  },
});
