import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/**
 * Validates + transforms a request part with a @dentalos/validation schema.
 *   @Post() create(@Body(new ZodPipe(createPatientRequest)) body: CreatePatientRequest) {}
 *   @Get() list(@Query(new ZodPipe(searchPatientsQuery)) q: SearchPatientsQuery) {}
 * Errors expose field paths and messages only (never the submitted values: they may be PII).
 */
@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new BadRequestException({
      error: "validation_failed",
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
}
