# stagepreview

Staging / preview deployment of DCPH-Tracker, self-hosted on the
`NoahOsmonth` Coolify instance. This branch exists so we can iterate on the
site without touching the upstream `main` or the Vercel production project.

- **Deploy target:** Coolify application `dcph-tracker-stagepreview`
  (project `Hosting`), built from this branch.
- **Image:** `Dockerfile` (multi-stage, Next.js standalone output).
- **Env:** public Supabase project values only (`NEXT_PUBLIC_*`). No
  service-role or admin secrets are set here, so admin-only maintenance routes
  stay disabled on staging.
- **Upstream sync:** `git fetch upstream && git rebase upstream/main`.

This branch is not meant to be merged upstream as-is: it adds the Docker build
(standalone output + `Dockerfile`) that the Vercel-hosted project does not need.
