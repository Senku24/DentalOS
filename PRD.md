# DentalOS — Product Requirements Document

**Document status:** Approved product decision record; implementation-ready baseline  
**Version:** 1.0  
**Decision baseline date:** 18 November 2026  
**Product:** DentalOS (working name; final branding not approved)  
**Market:** India-first; initial customer acquisition in Delhi NCR  
**Currency / language:** INR / English  

---

## 1. Product overview

DentalOS is a multi-tenant, enterprise-grade dental practice management SaaS for dental chains and multi-location dental organisations in India. It provides a shared patient record across an organisation, branch-aware clinical and operational workflows, treatment journey management, finance, inventory, patient self-service and integrated AI assistance.

DentalOS is a **complete dental practice management system with integrated AI capabilities**. It is not intended to be a generic clinic CRM or a single-clinic appointment tool.

### 1.1 Product goals

1. Give a dental organisation central oversight of multiple branches while preserving branch-level operating autonomy and data permissions.
2. Maintain one longitudinal patient profile within each organisation, with clinical and financial history attributable to the correct branch and staff member.
3. Support the patient journey from enquiry and registration through appointments, diagnosis, treatment planning, treatment sessions, billing and recall.
4. Improve chair, dentist, patient and inventory operations through reliable workflows and useful reporting.
5. Reduce administrative and documentation work with AI, without transferring clinical authority from dentists or bypassing user permissions.
6. Deliver a polished, responsive staff application and a separate mobile-first patient portal.

### 1.2 Non-goals for V1

- Native Android or iOS applications.
- Full sales CRM or lead-nurturing platform.
- Two-way WhatsApp receptionist inbox or AI WhatsApp chatbot.
- Autonomous clinical diagnosis, prescription, treatment selection or modification of signed records.
- Automated appointment optimisation, waitlists or recurring-booking automation.
- Full dental laboratory case management (planned for V1.5).
- Insurance / TPA claims, memberships and treatment packages.
- Payroll, attendance and statutory salary processing.
- Advanced periodontal charting and specialised clinical workflows.
- Advanced custom report builder.

---

## 2. Customers, users and tenancy

### 2.1 Target customer

Dental chains and multi-location dental groups, initially acquired in Delhi NCR. The initial product is designed for organisations that need central management of branches, staff, patient journeys, service pricing, finance and performance.

### 2.2 Applications

- **Staff application:** Responsive browser-based application, optimised for desktop and tablet. Essential workflows must remain usable on smaller screens.
- **Patient portal:** Separate browser-based experience, designed mobile-first. No native mobile application in V1.

### 2.3 Initial roles

Exactly six initial product roles:

1. Owner
2. Manager
3. Dentist
4. Receptionist
5. Accountant
6. Patient

Do not introduce additional first-class roles in V1 without an approved product change. Fine-grained permissions within these roles are required. The complete role/action/branch permission matrix is an implementation artefact to be defined before feature completion.

### 2.4 Multi-tenant model

- One tenant represents one subscribing dental organisation.
- An organisation can contain multiple branches.
- Each tenant has a shared patient identity and longitudinal patient profile across its branches.
- Each tenant's data must be isolated from every other tenant.
- Cross-branch visibility within a tenant is permission-controlled.
- Branch-scoped records retain their originating branch.
- Organisation-wide administration and reporting are available only to suitably authorised users.
- Patient users can access only their own authorised portal data.

**Patient identity boundary:** a patient profile is shared across branches of the same organisation. Do not assume a global patient identity shared across unrelated DentalOS tenants.

### 2.5 Attribution and history rules

- Appointments, encounters, financial transactions and operational events retain their originating branch and responsible actor.
- A dentist transfer changes future assignments only. It must not rewrite historical dentist, branch or revenue attribution.
- A branch-level service price override must be permission-controlled and audited.
- Clinical history shared across branches remains subject to the user's clinical and branch permissions.
- Historical clinical and financial records must not be silently overwritten.

---

## 3. Product experience and design system

### 3.1 Visual direction

- Minimal modern visual style.
- Warm white, charcoal and emerald palette.
- Light theme is the default. Dark mode may be considered later and must not delay V1.
- Avoid excessive gradients, glassmorphism, decorative animations and one-off visual patterns.

### 3.2 Staff application shell

- Expandable left navigation sidebar.
- Top bar containing organisation/branch switcher, global search, notifications and account controls.
- Main working area with contextual drawers or panels where useful.
- Breadcrumbs for deeper navigation.
- Role-specific dashboards with configurable widgets built from shared components.

### 3.3 Role-oriented workspaces

- **Owner:** organisation-level performance, revenue, branch comparisons and consolidated views.
- **Manager:** branch operations, appointments, staff, collections and branch performance.
- **Dentist:** schedule, waiting queue, clinical workspace, odontogram, encounters and treatment plans.
- **Receptionist:** appointments, check-in, patient registration and waiting queue.
- **Accountant:** invoices, collections, refunds, outstanding balances and financial reports.
- **Patient:** personal appointments, treatment plans, invoices, documents, consent and payments.

### 3.4 Clinical workspace

A dedicated clinical workspace must bring together patient identity and alerts, relevant history, interactive FDI odontogram, clinical notes, diagnosis/procedure information and treatment-plan history. It must make the treating dentist and the encounter context clear.

### 3.5 Patient portal

The patient portal has a distinct visual identity and mobile-first interaction design. It must not expose staff-only navigation, internal operational data or another patient's records.

### 3.6 Design-system requirements

- Shared design tokens for colour, typography, spacing, borders, radii and shadows.
- Reusable buttons, inputs, selects, tables, badges, dialogs, drawers and navigation components.
- Consistent validation, error, loading, empty and success states.
- Keyboard navigation, visible focus states and accessibility target of WCAG 2.2 AA.
- Hybrid data presentation: summary cards plus information-dense tables with filtering, sorting, pagination and saved views where appropriate.
- Global/command search, keyboard shortcuts, quick actions, contextual drawers and safe inline status changes.
- No arbitrary one-off styling where an existing design-system component is appropriate.

---

## 4. V1 functional scope

All requirements below are V1 unless explicitly marked later-phase. The implementation team must provide acceptance tests for each module.

### 4.1 Organisation and branch administration

**V1 requirements**

- Organisation onboarding and settings.
- Create, edit, activate and deactivate branches.
- Invite and manage staff.
- Assign one of the six approved roles and applicable branch scope.
- Maintain dentist-to-branch assignments and support dentist transfers.
- Maintain a central service/procedure catalogue and central pricing.
- Allow controlled, audited branch-level price overrides.
- Provide organisation and branch dashboards.
- Enforce tenant isolation and branch-aware permissions on every relevant operation.

**Deferred:** advanced custom permission builder and complex organisational hierarchies.

### 4.2 Patient management and intake

**V1 requirements**

- Create and maintain a shared patient profile within an organisation.
- Capture basic enquiry/lead details, including contact details, source and area of interest. This is not a full CRM.
- Support appointment-based registration, walk-ins and emergency/urgent intake.
- Capture medical and dental history, allergies and clinical alerts.
- Search and filter patients.
- Detect likely duplicate patients and support controlled merging with an audit trail.
- Store documents and attachments against the patient record.
- Track consent and communication preferences.
- Preserve patient identity across branches within the same tenant.

**Patient lifecycle:** enquiry → registration and identity verification → appointment / walk-in / urgent intake → check-in and waiting → consultation and assessment → diagnosis and charting → treatment plan and estimate → patient approval / consent → treatment sessions → invoices and payments → follow-up → recall / preventive-care reminders.

The identity-verification mechanism and duplicate-matching rules must be specified during implementation; do not merge patients automatically without an authorised, auditable workflow.

### 4.3 Appointment scheduling and front-desk operations

**V1 requirements**

- Day, week and month calendar views.
- Filter by branch, dentist and dental chair/operatory.
- Store patient, branch, dentist (initially unassigned is permitted), chair, appointment type, duration, date/time and status.
- Configure dentist working hours, branch hours and chair availability.
- Detect conflicting dentist and chair bookings.
- Support booking, rescheduling and cancellation.
- Support walk-in and urgent visits.
- Support patient check-in and waiting status.
- Link appointments to treatment plans and relevant procedures.
- Preserve appointment history and actor attribution.

**Deferred:** waitlists, recurring bookings and automatic slot optimisation/scheduling suggestions.

### 4.4 Clinical records and odontogram

**V1 requirements**

- Structured FDI two-digit tooth numbering.
- Permanent and primary dentition.
- Tooth-level and surface-level conditions.
- Patient medical/dental history, allergies and alerts visible in the clinical context.
- Clinical encounters and notes.
- Diagnosis and procedure records.
- Attach X-rays, images, scans and supporting documents.
- Attribute clinical work to the dentist, branch, encounter and timestamps.
- Maintain audit history.
- Preserve completed and signed encounters. Corrections must be made through attributable, audited amendments; never silently overwrite a signed record.

**Deferred:** advanced periodontal charting and specialised clinical measurements/workflows.

### 4.5 Treatment planning and treatment journey

**V1 requirements**

- Multiple treatment plans per patient.
- Itemised procedures, estimates and applicable tooth/surface associations.
- Phases and sequencing.
- Procedure-level status tracking.
- Partial acceptance, rejection or deferral of individual procedures.
- Multiple sessions per procedure.
- Patient approval and consent workflow.
- Version history for plans and estimates.
- Progress tracking from proposed through accepted, scheduled, in progress and completed states.
- Preserve what was proposed, accepted, changed, deferred and completed, with timestamps and responsible actors.

### 4.6 Finance, billing and dentist compensation

**V1 requirements**

- Estimates distinct from invoices.
- Procedure/session-based billing and consolidated invoices.
- Advance payments, deposits, partial payments and split payments.
- Instalments/payment plans.
- Discounts, refunds, receipts and patient account statements.
- Outstanding balances and payment history.
- Support cash, UPI, cards and bank transfer recording.
- Online payments through a payment gateway; verify payment success server-side using the provider's trusted confirmation/webhook. Never trust a client-side success assertion.
- Branch-level and consolidated organisation financial reporting.
- Revenue attribution by branch and dentist.
- Configurable dentist compensation / revenue-share calculations and reports.

**Not included:** payroll, salary processing, attendance and statutory payroll.

**Open implementation rule:** commission formulas, eligible revenue definitions, settlement timing and adjustment treatment require an explicit configuration specification before commission calculations are released. Never silently change a historical commission basis.

Financial transactions, invoices, refunds and adjustments must be distinct auditable records. Do not mutate a posted financial record to conceal or erase its history.

### 4.7 Communications and notifications

**V1 channels:** WhatsApp transactional notifications, email and SMS.

**V1 requirements**

- Appointment confirmations, reminders and changes.
- Payment confirmations and receipts.
- Configurable message templates.
- Delivery status where supported by the provider.
- Consent and opt-out preferences.
- Auditable notification events and sending actor/source.

WhatsApp is a transactional notification channel only in V1. No two-way receptionist inbox, AI WhatsApp conversations or autonomous clinical instructions. Clinical messages or patient-facing clinical explanations require the appropriate authorised review before sending.

### 4.8 Inventory and consumables

**V1 requirements**

- Product and consumable catalogue.
- Branch-level stock tracking.
- Stock receipts and usage records.
- Stock adjustments with reasons and actor attribution.
- Low-stock alerts.
- Inter-branch stock transfers with dispatch/receipt traceability.
- Supplier records.

**Deferred:** predictive inventory demand forecasting.

### 4.9 Analytics and dashboards

**Organisation dashboard**

- Total and new patients.
- Appointments and completed visits.
- Revenue and collections.
- Outstanding balances.
- Branch and dentist performance.
- Cancellations and no-shows.
- Cross-branch comparisons subject to permissions.

**Branch dashboard**

- Daily appointments.
- Waiting patients.
- Dentist availability.
- Daily collections.
- Outstanding payments.
- Operational summaries.

Use clean summary cards and professional, data-rich tables. Support relevant filtering, sorting and pagination. Advanced custom report builder and custom KPI engine are deferred.

### 4.10 Patient portal

**V1 requirements**

- Secure patient login.
- View and manage own profile.
- View and book appointments; reschedule within configured clinic rules.
- View treatment plans and estimates.
- View invoices and payment history.
- Access only authorised clinical documents.
- Receive relevant notifications.
- Review and approve applicable consents and treatment plans.
- Make online payments.

Patient portal access must be tenant-bound and patient-bound. Sensitive documents require authorised access checks and secure delivery; never expose public object-storage URLs.

### 4.11 Laboratory management

Full dental laboratory case tracking is part of the broader product vision but is **not V1**. Target V1.5. Do not expand V1 to include full lab workflows without an approved scope change.

---

## 5. AI capabilities and automation

### 5.1 AI product strategy

DentalOS is an AI-first PMS: AI is embedded in relevant workflows and also available through a central assistant. The assistant must operate within the current user's tenant, branch and role permissions.

### 5.2 Approved V1 AI capabilities

1. Patient history summaries.
2. Clinical encounter summaries.
3. AI-generated clinical note drafts.
4. English and Hindi voice-to-clinical-note drafts.
5. Patient-friendly treatment-plan explanations.
6. Natural-language analytics queries.
7. Daily branch performance summaries.

### 5.3 Central assistant behaviour

- Retrieve and explain data the current user is authorised to access.
- Summarise records and operational information.
- Prepare drafts and proposed actions.
- Execute a supported mutation or send a communication only after showing the proposed action and receiving explicit user confirmation.
- Never use AI as a way to bypass application authorisation, tenant isolation or approval workflows.
- Do not imply an action succeeded until the underlying application operation confirms success.

V1 should not autonomously book/cancel appointments, issue refunds, change billing, alter clinical records or send unreviewed clinical content. Action execution can only be enabled for specific workflows that have explicit product requirements and acceptance tests.

### 5.4 Clinical AI safeguards

- AI may summarise and draft clinical documentation.
- Clinical decision-support policy permits suggestions such as possible diagnoses, treatment options or clinical considerations for a dentist to evaluate. These are suggestions, not confirmed diagnoses, prescriptions or treatment decisions.
- A dentist retains clinical authority and must review and approve AI-generated clinical content before it becomes an authorised clinical record or is communicated as clinical advice.
- AI must not independently diagnose, prescribe, authorise treatment or modify a signed record.
- AI-assisted content must be visibly identifiable and attributable.
- Signed records are immutable except through a separate, audited amendment workflow.

The approved V1 feature list does not separately specify autonomous image interpretation or a standalone AI diagnostic feature. Do not silently add either to V1.

### 5.5 Voice and transcription

- English and Hindi voice dictation are in V1.
- Audio is transcribed and converted into a structured clinical-note draft.
- The dentist reviews and edits the draft before approval and saving.
- Obtain appropriate consent before recording or processing consultation audio.
- Raw audio is not retained by default after transcription. Any exception requires an explicit retention purpose, policy and approval.

### 5.6 AI provider and data rules

- Use a provider-agnostic abstraction layer; do not bind business logic to one model provider.
- Actual providers, models and routing strategy are selected during technical implementation after security and data-residency validation.
- Patient data must not be used to train external AI models.
- Provider contracts and settings must prevent model training on submitted patient data and define retention/deletion handling.
- Patient data and AI processing must comply with the India-only data residency/processing decision. If a provider cannot meet the required region and contractual safeguards, do not send identifiable patient data to it; select a compliant alternative or keep the feature disabled for that data class.
- Minimise prompts and attachments; send only the information necessary for the task.

### 5.7 AI access, transparency and governance

- Apply tenant, branch and role permissions server-side before retrieving any data for AI.
- Log AI activity: user/actor, tenant and permitted scope, timestamp, feature/model/provider, action type, approval and execution outcome, subject to data-minimisation rules.
- Clearly label AI-generated or AI-assisted content.
- Provide organisation-level enable/disable controls for AI features.
- Provide role-based access to AI capabilities.
- Provide usage monitoring, limits and included quotas; exact quotas and overage-pack sizing are a commercial configuration decision.

### 5.8 Later AI capabilities

- **V1.5:** appointment scheduling suggestions, no-show/cancellation pattern analysis, personalised follow-up suggestions.
- **V2:** inventory demand forecasting and AI conversational receptionist, subject to a new scope and safety review.

### 5.9 Non-AI automation

Rule-based automation is distinct from generative AI. Configured reminders, confirmations and other approved deterministic workflows may execute automatically under administrator-defined rules. AI-generated clinical advice must not be automatically sent to patients without the required clinician approval.

---

## 6. Technical architecture

### 6.1 Approved stack

| Layer | Decision |
|---|---|
| Application architecture | Modular monolith |
| Staff and patient web apps | Next.js + React + TypeScript |
| Backend framework/runtime | NestJS on Bun runtime, subject to mandatory production-readiness proof of concept |
| Database | PostgreSQL, shared database/schema with tenant isolation and PostgreSQL Row-Level Security |
| ORM | Prisma; use raw SQL selectively where justified |
| API | REST with OpenAPI documentation |
| Real-time updates | WebSockets and/or Server-Sent Events where required |
| Authentication | Managed identity provider; DentalOS owns tenant membership, roles and permissions |
| Cloud | AWS Mumbai region; India-only data residency/processing for patient data, databases, backups and required logs |
| Repository | Turborepo monorepo |
| CI/CD | GitHub Actions |

### 6.2 Bun/NestJS compatibility gate

NestJS + Bun is the approved preference, not an unconditional assumption of runtime compatibility. Before building the full platform, M0 must prove the selected NestJS adapters and libraries work under Bun in production-like conditions.

The proof of concept must cover at least:

- HTTP server and selected NestJS adapter.
- Authentication and session/token verification.
- Prisma connectivity, transactions and migrations.
- Background job execution and retries.
- File upload/download flows.
- WebSocket/SSE functionality used by the product.
- Structured logging, tracing and error monitoring.
- Graceful shutdown, health checks and container deployment.

If a critical compatibility issue cannot be resolved safely, retain NestJS and switch the production runtime to Node.js LTS. Do not compromise reliability to preserve Bun.

### 6.3 Architecture style

Use a modular monolith with clearly bounded business modules and explicit module interfaces. Do not introduce microservices in V1. Background workers may be separately deployed processes using the same codebase and domain modules; this is not a mandate to create distributed business services.

Suggested module boundaries:

- Identity and access
- Organisations and branches
- Patients
- Appointments and front desk
- Clinical records and odontogram
- Treatment planning
- Billing and finance
- Dentist compensation
- Communications
- Inventory
- Analytics and reporting
- Patient portal
- AI orchestration and governance
- Audit and compliance

### 6.4 Monorepo organisation

Use a Turborepo monorepo with independently buildable/deployable applications and shared packages. Exact package names may be chosen by the implementation team, but boundaries should include:

- Staff web application.
- Patient portal application.
- Backend API application.
- Background worker application/process.
- Shared TypeScript contracts and API types.
- Shared validation schemas.
- Shared UI/design system.
- Database schema/client and migrations.
- Shared configuration and observability utilities.

### 6.5 Multi-tenant database controls

- Shared PostgreSQL database/schema for tenants.
- Tenant-owned tables carry a tenant identifier; branch-scoped records also carry branch attribution where applicable.
- Enable and enforce PostgreSQL RLS for tenant isolation.
- Set tenant context safely within each database transaction/connection scope; fail closed if context is missing or invalid.
- Enforce authorisation in application services as well as database policies. Never rely on client-supplied tenant or branch identifiers.
- Cross-tenant and cross-branch access must be covered by automated negative tests.
- Any privileged/system process that can bypass RLS must be tightly restricted, separately audited and unavailable to normal request paths.

### 6.6 API and asynchronous processing

- REST APIs are the primary application interface.
- Publish OpenAPI contracts and validate request/response payloads.
- Use WebSockets/SSE for workflows that need live queue, calendar, status or dashboard updates.
- Use background workers for notifications, AI processing, reporting jobs, imports and other asynchronous tasks.
- Asynchronous jobs must preserve tenant context, actor/source attribution, idempotency and retry safety.

### 6.7 Cloud and deployment model

- Containerised application services on AWS in the Mumbai region.
- Managed PostgreSQL.
- Independently deployable API and background worker processes.
- Infrastructure as code.
- Controlled rolling deployments and rollback capability.
- Separate infrastructure, databases, credentials and secrets across staging and production.
- Exact AWS compute, networking, object storage, queue, secrets and monitoring services are implementation decisions; select managed services appropriate to the approved architecture without changing the data-residency requirement.

### 6.8 External providers to select

Provider selection is not locked for:

- Managed identity provider.
- Payment gateway.
- WhatsApp Business API provider.
- SMS and email providers.
- Object/file storage implementation.
- AI inference and speech-to-text providers.
- Monitoring/error-tracking platform.

Each provider must pass security, privacy, data-residency, contractual, operational and cost evaluation before production patient data is shared with it.

---

## 7. Security, privacy and compliance

### 7.1 Data residency

Patient data, databases, backups and required logs must remain in India. Default AWS region is Mumbai. External processors, AI providers and support tools must be evaluated to ensure they do not violate this requirement.

### 7.2 Encryption and secrets

- TLS for data in transit.
- Encryption at rest for databases, object storage, backups and logs.
- AWS KMS-managed encryption and key rotation.
- Additional field-level protection for highly sensitive data where the threat model requires it.
- Secrets must be stored in a managed secrets facility, never committed to source control or embedded in images.

### 7.3 Authentication and sessions

- Mandatory MFA for all staff users.
- Secure OTP/passwordless patient authentication.
- Secure session management, revocation and expiry.
- Managed identity provider handles authentication primitives; DentalOS remains authoritative for organisation membership and authorisation.
- Privileged actions require appropriate re-authentication/step-up controls where justified by the risk assessment.

### 7.4 Authorisation

- RBAC combined with branch-level permissions and tenant isolation.
- PostgreSQL RLS as a defence-in-depth boundary.
- Least-privilege access by default.
- Audited emergency/break-glass access with a defined purpose and review process.
- Apply permissions consistently to APIs, background jobs, exports, search, analytics, file access and AI retrieval.

### 7.5 Audit and record integrity

Maintain tamper-resistant audit trails for:

- Sensitive patient record access.
- Clinical record creation, amendments, approvals and signing.
- Treatment-plan and consent changes.
- Invoices, payments, refunds, discounts and adjustments.
- Patient exports and sensitive document access.
- Staff, role, permission, branch and pricing changes.
- AI activity, approval and execution.
- Administrative and emergency access.

Audit events should identify actor, action, subject/resource, tenant, branch where relevant, timestamp, source and outcome. Do not record unnecessary sensitive content in logs. Implement retention and secure deletion policies that meet all applicable statutory requirements.

### 7.6 Backups and disaster recovery — approved constrained scope

The selected baseline is **daily backups with manual recovery**, not automated point-in-time disaster recovery.

Mandatory minimum controls:

- Daily encrypted backups.
- Backups stored in India.
- Restricted backup access and separation from ordinary application credentials.
- Documented manual restoration procedure.
- Successful backup restoration test before launch and periodic tests thereafter.
- Backup completion/failure monitoring and alerting.

RPO/RTO targets and high-availability/point-in-time recovery upgrades have not been approved. They must be explicitly assessed and agreed before production launch. Do not silently assume that daily backup/manual recovery meets an unstated availability target.

### 7.7 Privacy and patient rights

Implement workflows and records for:

- Clear privacy notices and purpose-specific processing information.
- Consent capture, versioning, evidence and withdrawal where consent is the applicable basis.
- Communication preferences and opt-out.
- Patient requests for access, correction and erasure, subject to applicable legal retention requirements.
- Grievance submission, ownership, tracking and response.
- Parental/guardian consent and appropriate handling for minors.
- Retention schedules, legal holds and documented deletion/anonymisation.
- Processor/subprocessor inventory and contractual safeguards.

Do not erase clinical or financial records where applicable law requires retention. Legal counsel must define the applicable retention schedule and how a rights request is handled when erasure is restricted.

### 7.8 Security incident response

- Written incident response and escalation plan.
- Security monitoring and detection.
- Evidence preservation and incident timeline.
- Named incident owner and designated CERT-In point of contact, where applicable.
- Workflow to assess whether an event is a reportable CERT-In cyber incident and meet the applicable six-hour reporting requirement.
- Workflow to assess personal-data breach notification duties and applicable timelines.
- Customer/tenant communication process and post-incident review.

The CERT-In Directions dated 28 April 2022 include six-hour reporting for specified incidents and secure retention of ICT logs for a rolling 180 days within Indian jurisdiction. Confirm applicability and operational interpretation with qualified counsel/security professionals.

### 7.9 Security assurance

- Secure development lifecycle.
- Threat modelling for tenant isolation, clinical records, payments, AI and patient portal.
- Automated static/dependency/security scanning.
- Secrets scanning and container/image scanning.
- Independent penetration test before production launch.
- Remediation of critical/high findings before launch according to an approved risk policy.
- Build toward ISO 27001 readiness; certification is not a precondition for V1 unless separately approved.

### 7.10 India regulatory readiness

Design for the Digital Personal Data Protection Act, 2023 and Digital Personal Data Protection Rules, 2025, and review the current commencement notifications at launch. As of this PRD's decision date, the Rules have a phased commencement schedule; the core substantive obligations are scheduled for 13 May 2027. Legal counsel must confirm the applicable requirements and dates before launch and whenever the regulatory position changes.

This PRD is an engineering requirements document, not legal advice. Also obtain a legal review of dental/clinical record retention, professional obligations, payment processing, minors, messaging consent and any applicable health-sector requirements.

---

## 8. Commercial model and pricing

### 8.1 Business model

- B2B subscription SaaS.
- Primary pricing metric: per branch per month.
- Three plans: Growth, Professional and Enterprise.
- Monthly and annual billing.
- Annual subscriptions receive a 15% discount.
- Guided demos and assisted onboarding; no unrestricted permanent free tier.
- One-time onboarding fee.
- Core V1 PMS modules included across plans; tiers vary by capacity, AI allowance, storage and support.
- Patient portal accounts do not count as paid staff seats.

### 8.2 Approved indicative launch pricing

Prices below are in INR, per branch per month, excluding GST. They are approved initial commercial targets and should be validated with pilot customers before being treated as immutable list prices.

| Plan | Monthly price | Initial capacity | Positioning |
|---|---:|---|---|
| Growth | ₹5,999 | Up to 3 dentists and 10 staff per branch | Smaller multi-branch groups / entry tier |
| Professional | ₹9,999 | Up to 8 dentists and 25 staff per branch | Growing chains needing stronger analytics, AI allowance and priority support |
| Enterprise | ₹14,999+ | Custom capacity | Larger chains, enterprise controls, custom onboarding and support |

### 8.3 Onboarding and migration

- Growth onboarding: ₹15,000 one-time.
- Professional onboarding: ₹35,000 one-time.
- Enterprise onboarding: custom quote.
- Standard CSV/Excel imports are supported.
- Bespoke legacy-system migration beyond standard import tooling is quoted separately.
- The exact billing unit for the onboarding fee (per organisation, implementation engagement or branch) remains to be finalised in the order form.

### 8.4 AI monetisation

- Include an AI usage allowance in each plan.
- Additional usage is sold through prepaid usage packs.
- No automatic overage billing.
- Organisation admins can view usage and control AI access.
- Exact quotas, included model costs and prepaid pack prices are commercial configuration items to be finalised before selling subscriptions.

### 8.5 Commercial terms still to define

- GST presentation and invoicing configuration.
- Exact monthly/annual plan limits for storage, AI usage and support SLAs.
- Multi-branch volume discounts and minimum branch commitments.
- Upgrade/downgrade and cancellation rules.
- Trial/pilot conversion and credit policy.
- Onboarding fee billing unit and detailed deliverables.

---

## 9. Releases and delivery roadmap

### 9.1 Product releases

**V1 — Core DentalOS**

- Organisation and branch administration.
- Shared patient management and intake.
- Appointment and front-desk operations.
- Clinical records and FDI odontogram.
- Treatment planning and consent.
- Finance, billing, payments and configurable dentist compensation.
- WhatsApp transactional notifications, email and SMS.
- Inventory and consumables.
- Organisation/branch analytics.
- Patient portal.
- Seven approved V1 AI capabilities.

**V1.5**

- Full dental laboratory case tracking.
- Advanced patient engagement and feedback/reviews.
- Appointment scheduling suggestions.
- No-show/cancellation pattern analysis.
- Personalised follow-up suggestions.
- Additional operational automation.

**V2**

- Inventory demand forecasting.
- AI conversational receptionist, subject to safety, consent and product approval.
- Insurance/TPA workflows.
- Memberships and treatment packages.
- Advanced analytics and reporting.

**V3**

- Advanced clinical capabilities, including evaluation of advanced periodontal charting.
- Deeper integrations and workflow optimisation.
- Additional enterprise capabilities.

### 9.2 Implementation milestones

| Milestone | Deliverables |
|---|---|
| M0 — Foundation | Bun/NestJS compatibility POC; Turborepo; CI; environments; tenant model; PostgreSQL/RLS; authentication; role/branch authorisation; audit foundation; design system |
| M1 — Organisation & patients | Organisations, branches, staff, service catalogue/pricing, patient profile, intake, duplicate detection and documents |
| M2 — Clinical operations | Appointments, chairs, check-in, odontogram, encounters, clinical records, treatment plans and consent |
| M3 — Business operations | Estimates/invoices, payments, refunds, commissions, inventory, WhatsApp/email/SMS and background jobs |
| M4 — Complete V1 | Patient portal, analytics, AI capabilities, provider integrations and operational dashboards |
| M5 — Production readiness | Migration validation, security review, penetration test, load test, backup restore test, pilot rollout, support and launch sign-off |

### 9.3 Development and rollout approach

- Build incrementally, milestone by milestone, with integrated testing throughout.
- Pilot with 2–3 dental organisations in Delhi NCR.
- Start each pilot organisation with 1–2 branches, then progressively onboard the remaining branches.
- Provide assisted CSV/Excel migration with validation, duplicate review and migration reports.
- Use feature flags, staging, controlled releases, rollback capability and structured pilot feedback.
- Do not expand to a broad public launch until pilot acceptance criteria are satisfied.

---

## 10. Testing, quality and launch acceptance

### 10.1 Required test layers

- Unit tests for domain logic and validation.
- Integration tests for database, RLS, transactions, identity, storage and provider boundaries.
- API tests against OpenAPI contracts.
- End-to-end tests for critical staff and patient workflows.
- Multi-tenant isolation and cross-branch permission tests.
- Clinical record immutability and audited amendment tests.
- Financial integrity, reconciliation, refunds, idempotency and payment webhook tests.
- Appointment concurrency and dentist/chair conflict tests.
- AI permission, output provenance, review and approval tests.
- Background job retry, duplicate-delivery and tenant-context tests.
- Data migration validation and reconciliation tests.
- Security, dependency, container and penetration testing.
- Load/performance testing against agreed pilot and launch traffic assumptions.

### 10.2 CI/CD quality gates

GitHub Actions pipelines must validate, as applicable:

- Formatting and linting.
- Type checking.
- Unit/integration/API tests.
- Build and container validation.
- Dependency and security scanning.
- Database migration validation.
- Contract compatibility.
- Staging deployment smoke tests.

Production deployment must be controlled, observable and reversible. Database migrations must be designed with safe rollout/rollback or forward-fix procedures; destructive migrations require explicit review and backup/restore planning.

### 10.3 Environments

Maintain separate local development, staging and production environments. Use isolated databases, credentials, secrets, storage and provider configurations. Production patient data must not be copied into development or staging without an approved de-identification and privacy process.

### 10.4 Monitoring and operations

- Centralised application and infrastructure logs.
- Error tracking and alerting.
- Metrics and uptime monitoring.
- Background worker/job monitoring.
- Database health and capacity monitoring.
- Security and audit monitoring.
- Operational dashboards and support escalation procedure.
- Alerts for failed backups and failed restoration checks.

### 10.5 V1 launch acceptance criteria

Do not launch broadly until all of the following are true:

1. No unresolved critical security vulnerabilities; high-risk findings are resolved or formally risk-accepted by authorised leadership.
2. Tenant isolation and branch-level authorisation tests pass, including negative cross-tenant tests.
3. Critical clinical, appointment, treatment, billing and patient-portal workflows pass end-to-end tests.
4. Clinical record signing/amendment and financial transaction histories are auditable and cannot be silently overwritten.
5. Payment success is verified server-side and payment events are idempotent.
6. Patient consent, communication preferences and privacy request workflows are operational.
7. AI respects permissions, labels its output and enforces human review/confirmation requirements.
8. Provider privacy, security and data-residency checks are complete before patient data is processed by external providers.
9. Data migration is reconciled and formally signed off by each pilot organisation.
10. Daily backup restoration is successfully demonstrated; manual recovery procedures are documented.
11. Load/performance testing is complete against agreed capacity assumptions.
12. Monitoring, incident response, support escalation and rollback procedures are operational.
13. Pilot organisations formally sign off before broad rollout.

---

## 11. Product-level acceptance criteria

The following are release-level outcomes, not substitutes for detailed test cases:

- A user from Tenant A cannot read, modify, search, export or infer Tenant B data through any application, API, background job, analytics or AI path.
- A branch-scoped user cannot access another branch's restricted data unless explicitly authorised.
- A patient has one shared profile across branches of the same organisation, while appointments, encounters and finance retain their originating branch.
- Transferring a dentist does not alter historical records or attribution.
- A dentist can complete an encounter using the FDI chart and structured notes; signed content cannot be silently changed.
- A treatment plan supports multiple procedures, phases, partial acceptance/deferral and multiple sessions while preserving version history.
- An invoice/payment/refund/adjustment is represented by auditable financial records and contributes correctly to branch and organisation reporting.
- Staff can manage a patient's journey from enquiry/registration through appointment, treatment and payment.
- A patient can access only their own portal records and perform the permitted appointment and payment actions.
- Configured transactional notifications respect consent and opt-out settings.
- AI outputs are permission-scoped, visibly labelled and reviewed as required; AI cannot autonomously make clinical decisions.
- Organisation and branch dashboards show appropriately scoped operational and financial information.

---

## 12. Open implementation decisions and explicit constraints

The product gates define the direction and scope, but the following items must be resolved during engineering discovery or before the relevant feature ships. Do not invent these silently or treat them as locked product choices.

### 12.1 Architecture and infrastructure

- Result of the mandatory NestJS + Bun production-readiness POC; Node.js LTS is the approved fallback runtime if required.
- Exact AWS compute, networking, managed database configuration, object storage, queue, secrets, observability and infrastructure-as-code tooling.
- Exact database connection-pooling and RLS context propagation strategy.
- API versioning and realtime event contracts.
- Numeric performance, availability, RPO and RTO objectives. The approved daily-backup/manual-recovery choice may not satisfy the targets ultimately required by pilot customers.

### 12.2 Domain rules

- Full permission matrix for each role, branch scope and sensitive operation.
- Patient identity verification, duplicate matching and merge approval rules.
- Appointment status state machine, cancellation rules, grace periods and branch working-hour edge cases.
- Clinical note templates, sign-off rules and amendment/reopening policy.
- Detailed consent types, form templates and versioning.
- Dentist compensation formulas, eligible revenue, adjustments and commission settlement rules.
- Tax/GST invoice requirements and accounting/export needs.
- Payment gateway, reconciliation, refund and chargeback integration details.
- Inventory units of measure, stock valuation and procurement depth.

### 12.3 External providers and AI

- Identity provider, payment gateway, WhatsApp, SMS, email, object storage and monitoring providers.
- AI model provider(s), speech-to-text provider(s), model evaluation criteria, cost controls and fallback strategy.
- Proof that AI and other processors satisfy India-only processing/residency and contractual no-training/retention requirements before identifiable patient data is sent.
- AI allowance volumes, prepaid pack sizes and per-plan quotas.
- Exact central-assistant actions that may be executed after confirmation in V1.
- Whether any clinical decision-support suggestions beyond summarisation/drafting are included in the initial AI feature implementation; no independent diagnostic feature is approved by this PRD.

### 12.4 Commercial and operations

- Onboarding fee billing unit and detailed deliverables.
- Exact storage, support, AI and capacity entitlements by plan.
- Support hours, response targets and enterprise SLA.
- Multi-branch discounts, minimum commitments, renewal and cancellation terms.
- Pilot customer success metrics and formal sign-off template.
- Clinical/legal retention schedule and legal review of applicable India health, privacy, payment and professional obligations.

---

## 13. Engineering execution rules

1. Treat this document as the approved product baseline. Any scope or locked-decision change requires an explicit product decision and an update to this PRD.
2. Implement V1 before V1.5/V2/V3. Do not pull deferred features into V1 without approval.
3. Prioritise correctness, auditability and tenant isolation over shortcuts or premature microservice decomposition.
4. Never trust tenant, branch, patient, price, permission or payment status supplied only by the client.
5. Preserve historical clinical and financial records; use attributable amendments and reversal/adjustment records.
6. Apply the same permissions to APIs, background workers, exports, files, analytics and AI.
7. Use migrations and seed data reproducibly. Do not make manual production schema changes that are absent from source control.
8. Every completed module must include tests, observability, failure states and concise operational documentation.
9. Keep provider integrations behind interfaces and validate privacy/security terms before production use.
10. Do not claim a feature is complete until its acceptance criteria and negative/security tests pass.

---

## 14. Primary regulatory references

These references are starting points for legal/security review. Verify current versions, commencement notifications and applicability before launch.

- [Digital Personal Data Protection Rules, 2025 — Ministry of Electronics and Information Technology](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa)
- [Digital Personal Data Protection Act, 2023 — Gazette of India / MeitY](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf)
- [CERT-In Directions under Section 70B — official page](https://www.cert-in.org.in/Directions70B.jsp)
- [CERT-In Directions dated 28 April 2022 — official PDF](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf)

---

**End of PRD — DentalOS v1.0**
