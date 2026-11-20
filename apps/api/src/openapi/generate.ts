import "reflect-metadata";
import * as validation from "@dentalos/validation";
import { ParseUUIDPipe, RequestMethod, type Type } from "@nestjs/common";
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { z } from "zod";
import { ZodPipe } from "../common/zod.pipe";
import { ROUTE_DOCS, type RouteDoc, UNTYPED_NOTE } from "./responses";

/**
 * OpenAPI 3.1 document derived from the Nest app itself — no hand-written spec, no @nestjs/swagger.
 *
 *  - Routes: module tree (`imports` / `controllers` metadata) → controller + handler PATH/METHOD
 *    metadata, exactly what Nest's router reads.
 *  - Inputs: route-argument metadata; every `ZodPipe` on `@Body` / `@Query` / `@Param` contributes its
 *    zod schema, converted with zod 4 `z.toJSONSchema` (input side, i.e. what clients send).
 *    Schemas exported by `@dentalos/validation` become named `components.schemas` ($ref'd).
 *  - Auth: AuthGuard metadata (`public`, `authenticated`, `permission`, `stepUp`) → security,
 *    the `X-Tenant-Id` header and `x-permission` / `x-step-up-max-age` extensions.
 *  - Responses: controllers return plain objects, so success bodies and route-specific error codes
 *    come from the `ROUTE_DOCS` registry (./responses.ts; output-side zod → JSON Schema). Every
 *    operation also lists the generic error envelope (400/401/403/404); 204 has no body. Operations
 *    without a registry entry say so in their success description (UNTYPED_NOTE).
 * Output is deterministic (sorted) so `openapi.json` can be diffed.
 */

type Json = Record<string, unknown>;
type Schema = Json;
type ZodSchema = z.ZodType;

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

const HTTP_METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
  [RequestMethod.PUT]: "put",
  [RequestMethod.PATCH]: "patch",
  [RequestMethod.DELETE]: "delete",
  [RequestMethod.OPTIONS]: "options",
  [RequestMethod.HEAD]: "head",
};

const ERROR_REF = { $ref: "#/components/responses/Error" };
const ENVELOPE_REF = { $ref: "#/components/schemas/ErrorEnvelope" };
const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
};

/** Error response restricted to the listed `error` codes. */
const codedError = (status: number, codes: string[]): Json => ({
  description: `${STATUS_TEXT[status] ?? "Error"}: ${codes.join(", ")}`,
  content: {
    "application/json": {
      schema: {
        allOf: [
          ENVELOPE_REF,
          { type: "object", properties: { error: { enum: codes } }, required: ["error"] },
        ],
      },
    },
  },
});

/** Collects controllers reachable from a root module (static `imports`, incl. dynamic modules). */
export function collectControllers(root: Type): Type[] {
  const seen = new Set<unknown>();
  const out: Type[] = [];
  const visit = (mod: unknown): void => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const dynamic = typeof mod === "object" ? (mod as { module?: Type }) : undefined;
    const cls = (dynamic?.module ?? mod) as Type;
    const imports: unknown[] = [
      ...(Reflect.getMetadata("imports", cls) ?? []),
      ...((dynamic as { imports?: unknown[] } | undefined)?.imports ?? []),
    ];
    for (const c of [
      ...(Reflect.getMetadata("controllers", cls) ?? []),
      ...((dynamic as { controllers?: Type[] } | undefined)?.controllers ?? []),
    ] as Type[]) {
      if (!out.includes(c)) out.push(c);
    }
    for (const i of imports) {
      const fwd = (i as { forwardRef?: () => unknown } | undefined)?.forwardRef;
      visit(fwd ? fwd() : i);
    }
  };
  visit(root);
  return out;
}

const asArray = (v: unknown): string[] =>
  v === undefined ? [""] : Array.isArray(v) ? v.map(String) : [String(v)];

const joinPath = (...parts: string[]) => {
  const p = `/${parts
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")}`;
  return p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
};

const zodOf = (pipes: unknown[] | undefined): ZodSchema | undefined => {
  for (const p of pipes ?? []) {
    if (p instanceof ZodPipe) return (p as unknown as { schema: ZodSchema }).schema;
  }
  return undefined;
};

const isUuidPipe = (pipes: unknown[] | undefined) =>
  (pipes ?? []).some((p) => p instanceof ParseUUIDPipe || p === ParseUUIDPipe);

const FORMATS_WITH_REDUNDANT_PATTERN = new Set(["uuid", "date-time", "date", "email"]);

/**
 * Drops per-schema `$schema` keys (the document dialect applies) and the long regexes zod emits next
 * to a standard `format` (uuid, date-time, date, email): the format already says it.
 */
function clean(s: Schema, io: "input" | "output" = "input"): Schema {
  const { $schema: _drop, ...rest } = s;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = v as Json;
    const out: Json = {};
    for (const [k, val] of Object.entries(o)) {
      if (k === "pattern" && FORMATS_WITH_REDUNDANT_PATTERN.has(String(o.format))) continue;
      // Response objects may gain fields; a closed schema would break strict client validators.
      if (io === "output" && k === "additionalProperties" && val === false) continue;
      out[k] = walk(val);
    }
    return out;
  };
  return walk(rest) as Schema;
}

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export interface OpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
}

export function generateOpenApi(root: Type, opts: OpenApiOptions = {}): Json {
  // Named request schemas: every zod schema exported by @dentalos/validation, by identity.
  const named = new Map<unknown, string>();
  for (const [k, v] of Object.entries(validation)) {
    if (v instanceof z.ZodType && !named.has(v)) named.set(v, pascal(k));
  }
  const components: Record<string, Schema> = {};
  const toJson = (s: ZodSchema, io: "input" | "output" = "input"): Schema =>
    clean(
      z.toJSONSchema(s, {
        target: "draft-2020-12",
        io,
        unrepresentable: "any",
        reused: "inline",
        cycles: "ref",
      }) as Schema,
      io,
    );
  /** `$ref` for exported schemas (registered once), inline JSON Schema otherwise. */
  const ref = (s: ZodSchema): Schema => {
    const name = named.get(s);
    if (!name) return toJson(s);
    components[name] ??= toJson(s);
    return { $ref: `#/components/schemas/${name}` };
  };
  /** Same for response bodies (output side); a name already used as input gets an `Output` suffix. */
  const inputNames = () => new Set(Object.keys(components));
  const outputs = new Map<unknown, string>();
  const refOut = (s: ZodSchema): Schema => {
    const base = named.get(s);
    if (!base) return toJson(s, "output");
    let name = outputs.get(s);
    if (!name) {
      name = inputNames().has(base) ? `${base}Output` : base;
      outputs.set(s, name);
      components[name] = toJson(s, "output");
    }
    return { $ref: `#/components/schemas/${name}` };
  };

  const paths: Record<string, Record<string, Json>> = {};
  const operationIds = new Set<string>();

  for (const ctrl of collectControllers(root)) {
    const tag = ctrl.name.replace(/Controller$/, "") || ctrl.name;
    const ctrlPaths = asArray(Reflect.getMetadata(PATH_METADATA, ctrl));
    const proto = ctrl.prototype as Record<string, unknown>;
    const meta = (key: string, handler: unknown) =>
      Reflect.getMetadata(key, handler as object) ?? Reflect.getMetadata(key, ctrl);

    for (const name of Object.getOwnPropertyNames(proto).sort()) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      const methodNo: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
      const routePath = Reflect.getMetadata(PATH_METADATA, handler);
      if (methodNo === undefined || routePath === undefined) continue;
      const verb = HTTP_METHODS[methodNo];
      if (!verb) continue;

      const isPublic = meta("public", handler) === true;
      const isAuthenticated = meta("authenticated", handler) === true;
      const permission: string | undefined = isAuthenticated
        ? undefined
        : meta("permission", handler);
      const stepUp: number | undefined = meta("stepUp", handler);
      const sse = Reflect.getMetadata(SSE_METADATA, handler) === true;
      const httpCode: number | undefined = Reflect.getMetadata(HTTP_CODE_METADATA, handler);
      const success = String(httpCode ?? (verb === "post" ? 201 : 200));

      const parameters: Json[] = [];
      let requestBody: Json | undefined;
      let validates = false;
      // Nest stores route args on the controller class, keyed by the handler's property name.
      const args: Record<string, RouteArg> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {};
      const handlerArgs = Object.entries(args).sort(([, a], [, b]) => a.index - b.index);
      for (const [key, arg] of handlerArgs) {
        const type = Number(key.split(":")[0]);
        const schema = zodOf(arg.pipes);
        if (schema) validates = true;
        if (type === RouteParamtypes.BODY) {
          requestBody = {
            required: true,
            content: {
              "application/json": { schema: schema ? ref(schema) : { type: "object" } },
            },
          };
        } else if (type === RouteParamtypes.PARAM && typeof arg.data === "string") {
          parameters.push({
            name: arg.data,
            in: "path",
            required: true,
            schema: schema
              ? toJson(schema)
              : isUuidPipe(arg.pipes)
                ? { type: "string", format: "uuid" }
                : { type: "string" },
          });
        } else if (type === RouteParamtypes.QUERY) {
          if (typeof arg.data === "string") {
            parameters.push({
              name: arg.data,
              in: "query",
              schema: schema ? toJson(schema) : { type: "string" },
            });
            continue;
          }
          if (!schema) continue;
          const js = toJson(schema);
          const props = (js.properties ?? {}) as Record<string, Schema>;
          const required = new Set((js.required as string[] | undefined) ?? []);
          for (const prop of Object.keys(props).sort()) {
            const p = props[prop] as Schema;
            const { description, ...rest } = p;
            parameters.push({
              name: prop,
              in: "query",
              ...(required.has(prop) ? { required: true } : {}),
              ...(typeof description === "string" ? { description } : {}),
              schema: rest,
            });
          }
        }
      }

      for (const ctrlPath of ctrlPaths) {
        for (const rp of asArray(routePath)) {
          const path = joinPath(ctrlPath, rp);
          // Path params bound at controller level or without a pipe still need declaring.
          for (const m of path.matchAll(/\{([^}]+)\}/g)) {
            const pName = m[1] as string;
            if (!parameters.some((p) => p.in === "path" && p.name === pName)) {
              parameters.push({
                name: pName,
                in: "path",
                required: true,
                schema: { type: "string" },
              });
            }
          }
          const tenantHeader =
            !isPublic && !isAuthenticated ? [{ $ref: "#/components/parameters/TenantId" }] : [];
          let opId = `${tag}_${name}`;
          for (let i = 2; operationIds.has(opId); i++) opId = `${tag}_${name}_${i}`;
          operationIds.add(opId);

          const doc: RouteDoc = ROUTE_DOCS[opId] ?? {};
          const responses: Json = {
            [success]: sse
              ? {
                  description: "Server-sent event stream",
                  content: { "text/event-stream": { schema: { type: "string" } } },
                }
              : success === "204"
                ? { description: "No Content" }
                : doc.response || doc.items
                  ? {
                      description: "Success",
                      content: {
                        "application/json": {
                          schema: doc.items
                            ? {
                                type: "object",
                                properties: { items: { type: "array", items: refOut(doc.items) } },
                                required: ["items"],
                              }
                            : refOut(doc.response as ZodSchema),
                        },
                      },
                    }
                  : {
                      description: `Success. ${UNTYPED_NOTE}`,
                      content: { "application/json": { schema: {} } },
                    },
          };
          if (validates || parameters.length > 0 || requestBody) responses["400"] = ERROR_REF;
          if (!isPublic) {
            responses["401"] = ERROR_REF;
            responses["403"] = ERROR_REF;
          }
          if (path.includes("{")) responses["404"] = ERROR_REF;
          for (const [status, codes] of Object.entries(doc.errors ?? {})) {
            if (!codes?.length) continue;
            const all = status === "400" && validates ? ["validation_failed", ...codes] : codes;
            responses[status] = codedError(Number(status), all);
          }

          const op: Json = {
            operationId: opId,
            tags: [tag],
            ...(parameters.length || tenantHeader.length
              ? {
                  parameters: [
                    ...tenantHeader,
                    ...parameters.sort(
                      (a, b) =>
                        String(a.in).localeCompare(String(b.in)) ||
                        String(a.name).localeCompare(String(b.name)),
                    ),
                  ],
                }
              : {}),
            ...(requestBody ? { requestBody } : {}),
            responses,
            security: isPublic ? [] : [{ bearer: [] }],
            "x-auth": isPublic ? "public" : isAuthenticated ? "authenticated" : "member",
            ...(permission ? { "x-permission": permission } : {}),
            ...(stepUp !== undefined ? { "x-step-up-max-age": stepUp } : {}),
          };
          paths[path] ??= {};
          (paths[path] as Record<string, Json>)[verb] = op;
        }
      }
    }
  }

  const sortedPaths: Record<string, Json> = {};
  for (const p of Object.keys(paths).sort()) {
    const ops = paths[p] as Record<string, Json>;
    sortedPaths[p] = Object.fromEntries(
      Object.keys(ops)
        .sort()
        .map((k) => [k, ops[k]]),
    );
  }
  components.ErrorEnvelope = {
    type: "object",
    properties: {
      error: { type: "string", description: "Stable machine-readable code" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, message: { type: "string" } },
          required: ["path", "message"],
        },
      },
    },
  };
  const sortedSchemas = Object.fromEntries(
    Object.keys(components)
      .sort()
      .map((k) => [k, components[k]]),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "DentalOS API",
      version: opts.version ?? "0.0.0",
      description:
        opts.description ??
        "Generated from the Nest app (apps/api/scripts/openapi.ts). Do not edit by hand. " +
          "x-permission: required capability (services also enforce branch scope). " +
          "x-step-up-max-age: seconds since last sign-in, else 401 { error: 'reauth_required' }.",
    },
    paths: sortedPaths,
    components: {
      schemas: sortedSchemas,
      parameters: {
        TenantId: {
          name: "X-Tenant-Id",
          in: "header",
          required: true,
          description: "Tenant to act in; membership is verified server-side.",
          schema: { type: "string", format: "uuid" },
        },
      },
      responses: {
        Error: {
          description: "Error envelope",
          content: { "application/json": { schema: ENVELOPE_REF } },
        },
      },
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Cognito access token (staff pool, MFA enforced).",
        },
      },
    },
  };
}
