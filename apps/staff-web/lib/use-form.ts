"use client";
import type { z } from "@dentalos/validation";
import { type FormEvent, useCallback, useRef, useState } from "react";
import type { ApiError } from "./api/errors";
import { type FieldErrors, validate } from "./forms";

/**
 * Controlled form state validated by a shared zod schema.
 *  - `field(name)` spreads value/onChange/error onto a <TextField>/<SelectField>.
 *  - On an invalid submit focus moves to the first invalid control (WCAG 3.3.1).
 *  - `applyServerErrors(err)` maps API validation issues back onto fields.
 */
export function useForm<S extends z.ZodType, V extends Record<string, unknown>>(
  schema: S,
  initial: V,
  /** Optional raw → schema-input mapping (e.g. rupees → paise). */
  toInput: (v: V) => unknown = (v) => v,
) {
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);

  const set = useCallback(<K extends keyof V>(key: K, value: V[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!((key as string) in e)) return e;
      const { [key as string]: _, ...rest } = e;
      return rest;
    });
  }, []);

  const focusFirstInvalid = () =>
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
    });

  const field = (name: keyof V & string) => ({
    name,
    value: (values[name] ?? "") as string,
    error: errors[name],
    onChange: (e: { target: { value: string } }) => set(name, e.target.value as V[typeof name]),
  });

  const handleSubmit =
    (onValid: (data: z.output<S>) => void | Promise<void>) => async (e?: FormEvent) => {
      e?.preventDefault();
      const r = validate(schema, toInput(values));
      if (!r.ok) {
        setErrors(r.errors);
        focusFirstInvalid();
        return;
      }
      setErrors({});
      await onValid(r.data);
    };

  const applyServerErrors = (err: ApiError) => {
    if (Object.keys(err.fieldErrors).length) {
      setErrors(err.fieldErrors);
      focusFirstInvalid();
    }
  };

  const reset = (v: V = initial) => {
    setValues(v);
    setErrors({});
  };

  return { values, set, errors, setErrors, field, handleSubmit, applyServerErrors, reset, formRef };
}
