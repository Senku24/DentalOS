import { Module } from "@nestjs/common";
import { CategoriesController } from "./categories.controller";
import { ServicesController } from "./services.controller";

/**
 * M1 Service catalogue: categories, services (central price) and audited branch price overrides.
 * Owned by the catalog worker — add controllers/providers here only.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 */
@Module({
  controllers: [CategoriesController, ServicesController],
  providers: [],
})
export class CatalogModule {}
