import { ProjectDetail } from "../_components/project-detail";

/**
 * Next 14 — `params` is sync here, not a Promise.
 *
 * The raw string is passed straight through. It must NOT be cast to
 * Id<"projects">: every Convex function that takes it declares v.string() and
 * calls ctx.db.normalizeId, because a typo'd URL hitting a v.id() validator
 * throws ArgumentValidationError, which the Convex client logs via
 * console.error, which fails every e2e script's zero-console-error assertion.
 */
export default function ProjectPage({
  params,
}: {
  params: { locale: string; projectId: string };
}) {
  return <ProjectDetail projectId={params.projectId} />;
}
