"use client";
import type { PatientResponse } from "@dentalos/validation";
import { createContext, useContext } from "react";
import type { ApiError } from "../../../lib/api/errors";

export interface ProfileCtx {
  patient: PatientResponse;
  /** Read-only when the record was merged (all writes return 409 patient_merged). */
  readOnly: boolean;
  reloadPatient: () => void;
  /** Route every write error here so a 409 patient_merged flips the page into merged mode. */
  onWriteError: (e: ApiError) => void;
  branchName: (id: string | null | undefined) => string;
}

export const ProfileContext = createContext<ProfileCtx | null>(null);
export function useProfile(): ProfileCtx {
  const c = useContext(ProfileContext);
  if (!c) throw new Error("useProfile outside ProfileContext");
  return c;
}
