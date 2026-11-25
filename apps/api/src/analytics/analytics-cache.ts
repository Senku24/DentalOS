import { Injectable } from "@nestjs/common";
import { TtlCache } from "./analytics-common";

/**
 * The per-instance analytics cache (ADR 0005 §4.7): tenant + query + scope + params keys, TTL-only invalidation,
 * <= ANALYTICS_CACHE_MAX_ENTRIES per tenant. One instance shared by the dashboards and the catalogue service.
 */
@Injectable()
export class AnalyticsCache extends TtlCache {}
