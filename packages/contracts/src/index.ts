import generatedValidator from './generated/evidence-bundle-validator.mjs';
import generatedControlValidator from './generated/control-api-validator.mjs';
export * from './generated/types.js';
export * from './generated/control-types.js';
import type { NetOkayEvidenceBundle } from './generated/types.js';
import type { NetOkayControlAPIResponse } from './generated/control-types.js';

/** Public contract name; the underlying shape is generated from the canonical schema. */
export type EvidenceBundle = NetOkayEvidenceBundle;

export const validateEvidenceBundle = (value: unknown): value is EvidenceBundle =>
  generatedValidator(value) as boolean;

export const evidenceBundleValidationErrors = (): readonly unknown[] =>
  generatedValidator.errors ?? [];

export const evidenceBundleSchemaVersion = '2.0' as const;

export const validateControlResponse = (value: unknown): value is ControlResponse =>
  generatedControlValidator(value) as boolean;

/** Public Control API response union generated from the canonical control schema. */
export type ControlResponse = NetOkayControlAPIResponse;

export const controlResponseValidationErrors = (): readonly unknown[] =>
  generatedControlValidator.errors ?? [];
