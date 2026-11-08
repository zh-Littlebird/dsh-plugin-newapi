/** Reusable output-schema fragments. */

import { S } from '../schema.js'

export const NULLABLE_STRING = S.oneOf([S.string(), S.null()])
export const NULLABLE_NUMBER = S.oneOf([S.number(), S.null()])
export const NULLABLE_INTEGER = S.oneOf([S.integer(), S.null()])
export const NULLABLE_BOOLEAN = S.oneOf([S.boolean(), S.null()])

export const ERROR_SCHEMA = S.object(
  {
    code: S.string({ required: true }),
    message: S.string({ required: true }),
    hint: NULLABLE_STRING,
    status: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const USAGE_SCHEMA = S.object(
  {
    promptTokens: NULLABLE_INTEGER,
    completionTokens: NULLABLE_INTEGER,
    totalTokens: NULLABLE_INTEGER,
    reasoningTokens: NULLABLE_INTEGER,
    cachedTokens: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const TOOL_CALL_SCHEMA = S.object(
  {
    id: NULLABLE_STRING,
    type: S.string({ required: true }),
    name: S.string({ required: true }),
    arguments: S.string({ required: true }),
  },
  { additionalProperties: false },
)

export const SITE_SUMMARY_SCHEMA = S.object(
  {
    systemName: NULLABLE_STRING,
    version: NULLABLE_STRING,
    setup: NULLABLE_BOOLEAN,
    quotaPerUnit: NULLABLE_NUMBER,
    logMaxRangeDays: NULLABLE_NUMBER,
    startTime: NULLABLE_NUMBER,
  },
  { additionalProperties: false },
)

export const USER_SUMMARY_SCHEMA = S.object(
  {
    id: NULLABLE_INTEGER,
    username: NULLABLE_STRING,
    displayName: NULLABLE_STRING,
    role: NULLABLE_INTEGER,
    roleLabel: S.string({ required: true }),
    status: NULLABLE_INTEGER,
    group: NULLABLE_STRING,
    quota: NULLABLE_NUMBER,
    usedQuota: NULLABLE_NUMBER,
    requestCount: NULLABLE_INTEGER,
    affQuota: NULLABLE_NUMBER,
    affCount: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)

export const AUTH_CHECK_SCHEMA = S.object(
  {
    status: S.string({ required: true, enum: ['ok', 'missing', 'failed', 'skipped'] }),
    message: NULLABLE_STRING,
    modelCount: NULLABLE_INTEGER,
  },
  { additionalProperties: false },
)
