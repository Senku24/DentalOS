import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";

/**
 * M1 Patient documents: presigned upload, confirm, list, presigned download, soft delete.
 * Owned by the documents worker — add controllers/providers here only.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 */
@Module({
  controllers: [DocumentsController],
  providers: [],
})
export class DocumentsModule {}
