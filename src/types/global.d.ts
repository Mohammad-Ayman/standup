// Ambient declarations so `tsc --noEmit` passes before the first `next build`
// generates next-env.d.ts (which is gitignored).
declare module "*.css";
