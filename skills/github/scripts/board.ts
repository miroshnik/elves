/**
 * The repository's board — the one rule of the flow (#880): `github` sets Status and adds new tasks there, `est` writes
 * the actual's fields there and takes its rows from its items. Two rules diverged exactly where the owner gives the board
 * up the most natural way — closing the project: `github` went by the facts, `est` kept writing into the closed project
 * and missed the tasks created after it. Data and pure functions, no imports: `est` imports it (standard
 * `scripts#skill-imports`).
 */

/** A project as the scripts read it: enough to choose the board and to name it. */
export interface ProjectRef {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}

/** The GraphQL selection of a project for `ProjectRef`. */
export const PROJECT_REF = "id number title url closed";

/** The repository's linked projects — a selection inside `repository(…)`: the rule's input. */
export const LINKED_PROJECTS = `projectsV2(first: 20) { nodes { ${PROJECT_REF} } }`;

/** A project node of a GraphQL answer (the `PROJECT_REF` selection) as `ProjectRef`. */
export const projectRef = (p: { id: string; number: number; title: string; url: string; closed?: boolean | null }): ProjectRef => ({
  id: p.id,
  number: p.number,
  title: p.title,
  url: p.url,
  closed: !!p.closed,
});

/** The linked projects of a `LINKED_PROJECTS` answer; an empty node (a project without access) is skipped. */
export const linkedProjects = (connection: { nodes?: (Parameters<typeof projectRef>[0] | null)[] } | null | undefined): ProjectRef[] =>
  (connection?.nodes ?? []).flatMap((p) => (p ? [projectRef(p)] : []));

/**
 * The repository's board: the open linked project titled with the repository name, otherwise the first open linked one;
 * no open linked project — no board (#847): the owner gives the board up by closing or unlinking the project.
 */
export const mainProject = (repo: { name: string; linked: readonly ProjectRef[] }): ProjectRef | null =>
  repo.linked.find((p) => p.title === repo.name && !p.closed) ?? repo.linked.find((p) => !p.closed) ?? null;
