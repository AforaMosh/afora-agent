import * as claws from "./claws.js";

export const ClawsProtocolSchemas = {
  ClawDoctorFinding: claws.ClawDoctorFindingSchema,
  ClawResourceStatus: claws.ClawResourceStatusSchema,
  ClawStatusEntry: claws.ClawStatusEntrySchema,
  ClawsDoctorParams: claws.ClawsDoctorParamsSchema,
  ClawsDoctorResult: claws.ClawsDoctorResultSchema,
  ClawsStatusParams: claws.ClawsStatusParamsSchema,
  ClawsStatusResult: claws.ClawsStatusResultSchema,
} as const;
