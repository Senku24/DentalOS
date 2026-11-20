/**
 * Display-side mirror of the API authorship rule (apps/api/src/clinical/clinical-common.ts
 * assertAuthor / assertAuthorOrTreating, 403 not_author): only the author edits a draft note,
 * diagnosis or procedure (procedure status changes included); the author or the encounter's
 * treating dentist may delete it. The API stays the authority.
 */
export const canEditAuthored = (authorId: string | null | undefined, me: string | undefined) =>
  Boolean(me) && authorId === me;

export const canDeleteAuthored = (
  authorId: string | null | undefined,
  encounter: { treatingDentistUserId: string },
  me: string | undefined,
) => canEditAuthored(authorId, me) || (Boolean(me) && encounter.treatingDentistUserId === me);
